// Mergeable measurements for the load generator: log-bucketed histograms (percentiles within 2%), counters, and
// per-second time series. Workers send these to the main thread, which merges them; nothing here allocates per sample.

const MIN_MS = 0.1;
const RATIO = 1.02;
const LOG_RATIO = Math.log(RATIO);
const BUCKETS = 1100; // 0.1 ms .. about 0.1 * 1.02^1100 ≈ 3e8 ms

export interface HistogramData { counts: number[]; count: number; sum: number; max: number; min: number }

export class Histogram {
  counts = new Float64Array(BUCKETS);
  count = 0;
  sum = 0;
  max = 0;
  min = Infinity;

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const i = ms <= MIN_MS ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(ms / MIN_MS) / LOG_RATIO));
    this.counts[i]!++;
    this.count++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
    if (ms < this.min) this.min = ms;
  }

  merge(d: HistogramData): void {
    for (let i = 0; i < BUCKETS; i++) this.counts[i]! += d.counts[i] ?? 0;
    this.count += d.count;
    this.sum += d.sum;
    if (d.max > this.max) this.max = d.max;
    if (d.min < this.min) this.min = d.min;
  }

  /** The value at percentile p (0..100): the bucket's upper bound, capped at the true maximum. */
  pct(p: number): number {
    if (this.count === 0) return NaN;
    if (p >= 100) return this.max;
    const want = Math.max(1, Math.ceil((p / 100) * this.count));
    let seen = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.counts[i]!;
      if (seen >= want) return Math.min(this.max, MIN_MS * Math.pow(RATIO, i));
    }
    return this.max;
  }

  data(): HistogramData {
    // Sparse arrays travel cheaply between threads.
    return { counts: Array.from(this.counts), count: this.count, sum: this.sum, max: this.max, min: this.min };
  }

  summary(): { count: number; p50: number; p95: number; p99: number; max: number } {
    const r = (v: number) => (Number.isNaN(v) ? NaN : Math.round(v * 10) / 10);
    return { count: this.count, p50: r(this.pct(50)), p95: r(this.pct(95)), p99: r(this.pct(99)), max: r(this.max) };
  }
}

/** Named histograms, created on first use. Keys look like "heartbeat|fiber|steady". */
export class HistogramSet {
  readonly map = new Map<string, Histogram>();
  get(key: string): Histogram {
    let h = this.map.get(key);
    if (!h) { h = new Histogram(); this.map.set(key, h); }
    return h;
  }
  add(key: string, ms: number): void { this.get(key).add(ms); }
  data(): Record<string, HistogramData> { return Object.fromEntries([...this.map].map(([k, h]) => [k, h.data()])); }
  merge(d: Record<string, HistogramData>): void { for (const [k, v] of Object.entries(d)) this.get(k).merge(v); }
  /** Every histogram whose key matches all the given parts (empty part = any), merged into one. */
  select(...parts: (string | undefined)[]): Histogram {
    const out = new Histogram();
    for (const [k, h] of this.map) {
      const ks = k.split("|");
      if (parts.every((p, i) => p === undefined || p === "" || ks[i] === p)) out.merge(h.data());
    }
    return out;
  }
}

/** Counters keyed by name. */
export class Counters {
  readonly map = new Map<string, number>();
  inc(key: string, n = 1): void { this.map.set(key, (this.map.get(key) ?? 0) + n); }
  get(key: string): number { return this.map.get(key) ?? 0; }
  data(): Record<string, number> { return Object.fromEntries(this.map); }
  merge(d: Record<string, number>): void { for (const [k, v] of Object.entries(d)) this.inc(k, v); }
  /** Sum of every counter whose key starts with the prefix. */
  sum(prefix: string): number { let s = 0; for (const [k, v] of this.map) if (k.startsWith(prefix)) s += v; return s; }
}

/**
 * Per-second counts since the run's start (second 0 = run start). Each key is a series; drain() hands over what was
 * counted since the last drain so a worker can ship it without keeping the whole run.
 */
export class Series {
  private pending = new Map<string, Map<number, number>>();
  constructor(private readonly t0: number) {}
  inc(key: string, n = 1, at = Date.now()): void {
    const s = Math.max(0, Math.floor((at - this.t0) / 1000));
    let m = this.pending.get(key);
    if (!m) { m = new Map(); this.pending.set(key, m); }
    m.set(s, (m.get(s) ?? 0) + n);
  }
  drain(): Record<string, [number, number][]> {
    const out = Object.fromEntries([...this.pending].map(([k, m]) => [k, [...m]]));
    this.pending = new Map();
    return out;
  }
}

/** The main thread's merged series: key -> second -> count. */
export class SeriesStore {
  readonly map = new Map<string, Map<number, number>>();
  merge(d: Record<string, [number, number][]>): void {
    for (const [k, pairs] of Object.entries(d)) {
      let m = this.map.get(k);
      if (!m) { m = new Map(); this.map.set(k, m); }
      for (const [s, n] of pairs) m.set(s, (m.get(s) ?? 0) + n);
    }
  }
  total(key: string, from = 0, to = Infinity): number {
    let t = 0;
    for (const [s, n] of this.map.get(key) ?? []) if (s >= from && s < to) t += n;
    return t;
  }
  /** Sum over all keys starting with prefix. */
  totalPrefix(prefix: string, from = 0, to = Infinity): number {
    let t = 0;
    for (const k of this.map.keys()) if (k.startsWith(prefix)) t += this.total(k, from, to);
    return t;
  }
  peak(key: string): { perSecond: number; atSecond: number } {
    let best = 0, at = -1;
    for (const [s, n] of this.map.get(key) ?? []) if (n > best) { best = n; at = s; }
    return { perSecond: best, atSecond: at };
  }
}

/** Percentile of a plain array (small arrays only). */
export function pct(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** A small seeded random generator (mulberry32), so a run's link classes and outage membership are repeatable. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal sample (Box-Muller). */
export function normal(rand: () => number = Math.random): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** A lognormal sample with the given median and 99th percentile. */
export function lognormal(median: number, p99: number, rand: () => number = Math.random): number {
  const sigma = Math.log(p99 / median) / 2.3263;
  return median * Math.exp(sigma * normal(rand));
}

/** A string hashed to a 32-bit seed (FNV-1a). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

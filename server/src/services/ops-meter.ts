// Operations telemetry kept in memory and written once a minute (docs/platform/operations.md). It records COUNTS only: a kind from a
// fixed list, a short code (a route pattern, an error class, a status) and a number. Never a message, an identifier or a payload:
// codes are cut down to a safe alphabet and a bounded vocabulary, so nothing a caller sends can end up in the table.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { raiseSecurityAlertNow } from "./security.js";
import { errorInfo, type Pool } from "../db/db.js";

/** What may be counted. A counter adds up; a gauge ("g_" prefix) keeps the highest value seen in the hour. */
export const OPS_KINDS = ["requests", "http_5xx", "error_class", "shed", "agent_auth_fail", "retention", "retention_rows", "g_db_wait_p95_ms", "g_loop_lag_p95_ms"] as const;
export type OpsKind = (typeof OPS_KINDS)[number];
const KINDS = new Set<string>(OPS_KINDS);
export const isGauge = (kind: string): boolean => kind.startsWith("g_");

/** At most this many different codes are held between two writes; more are counted as "other". */
const MAX_CODES = 300;

/** A code is a short word-like string from a fixed alphabet; anything else is flattened to "_". */
export function safeCode(code: string): string {
  return code.replace(/[^A-Za-z0-9_.:/\-]/g, "_").slice(0, 80) || "_";
}

export interface Drained { counts: Map<string, number>; gauges: Map<string, number> }
const key = (kind: string, code: string): string => `${kind}\u0000${code}`;
export const splitKey = (k: string): [string, string] => { const i = k.indexOf("\u0000"); return [k.slice(0, i), k.slice(i + 1)]; };

export class OpsMeter {
  private counts = new Map<string, number>();
  private gauges = new Map<string, number>();

  count(kind: OpsKind, code: string, n = 1): void {
    if (!KINDS.has(kind) || isGauge(kind) || !Number.isFinite(n) || n <= 0) return;
    let k = key(kind, safeCode(code));
    if (!this.counts.has(k) && this.counts.size >= MAX_CODES) k = key(kind, "other");
    this.counts.set(k, (this.counts.get(k) ?? 0) + n);
  }

  /** Keeps the highest value (milliseconds) seen since the last write. */
  gauge(kind: OpsKind, code: string, value: number): void {
    if (!KINDS.has(kind) || !isGauge(kind) || !Number.isFinite(value) || value < 0) return;
    const k = key(kind, safeCode(code));
    this.gauges.set(k, Math.max(this.gauges.get(k) ?? 0, Math.round(value)));
  }

  /** Takes everything counted so far, leaving the meter empty. */
  drain(): Drained {
    const out = { counts: this.counts, gauges: this.gauges };
    this.counts = new Map(); this.gauges = new Map();
    return out;
  }

  /** Puts counts back after a failed write (bounded, so a long database outage cannot grow memory). */
  restore(d: Drained): void {
    for (const [k, n] of d.counts) {
      if (!this.counts.has(k) && this.counts.size >= MAX_CODES) continue;
      this.counts.set(k, (this.counts.get(k) ?? 0) + n);
    }
    for (const [k, v] of d.gauges) this.gauges.set(k, Math.max(this.gauges.get(k) ?? 0, v));
  }
}

/** The process-wide meter every part of the server counts into. */
export const opsMeter = new OpsMeter();

/** A route pattern (never the concrete URL, which can carry identifiers) or "unmatched". */
export const routeOf = (request: { routeOptions?: { url?: string | undefined } | undefined }): string => request.routeOptions?.url ?? "unmatched";

/** Counts one answered request: all requests, sheds (503 and 429), and other 5xx by route. */
export function noteResponse(api: "agent" | "console", route: string, status: number, meter: OpsMeter = opsMeter): void {
  meter.count("requests", api);
  if (status === 503 || status === 429) meter.count("shed", `${api}:${status}`);
  else if (status >= 500) meter.count("http_5xx", `${api}:${route}:${status}`);
}

/** Counts the class of an unexpected error: its type and driver or SQL Server code, never its message. */
export function noteError(api: "agent" | "console", error: unknown, meter: OpsMeter = opsMeter): void {
  const i = errorInfo(error);
  meter.count("error_class", `${api}:${i.type}${i.code ? `:${i.code}` : i.number !== undefined ? `:${i.number}` : ""}`);
}

// ---- Writing --------------------------------------------------------------------------------------------------------------------

/** Adds a drained batch to the hourly rows in one statement (counters add up, gauges keep the highest). */
export async function writeOpsCounters(pool: Pool, d: Drained, now = Date.now()): Promise<void> {
  const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
  const rows: { h: string; k: string; c: string; n: number; g: number }[] = [];
  for (const [k, n] of d.counts) { const [kind, code] = splitKey(k); rows.push({ h: hour, k: kind, c: code, n, g: 0 }); }
  for (const [k, n] of d.gauges) { const [kind, code] = splitKey(k); rows.push({ h: hour, k: kind, c: code, n, g: 1 }); }
  if (rows.length === 0) return;
  rows.sort((a, b) => (a.k + a.c < b.k + b.c ? -1 : 1)); // the same order everywhere, so two processes do not deadlock
  await pool.query(
    `MERGE ops_counters WITH (HOLDLOCK) AS t
     USING (SELECT [h], [k], [c], [n], [g] FROM OPENJSON($1) WITH ([h] datetime2(0) '$.h', [k] varchar(32) '$.k', [c] varchar(80) '$.c', [n] bigint '$.n', [g] bit '$.g')) AS s
        ON t.[hour] = s.[h] AND t.[kind] = s.[k] AND t.[code] = s.[c]
      WHEN MATCHED THEN UPDATE SET [count] = CASE WHEN s.[g] = 1 THEN (CASE WHEN t.[count] > s.[n] THEN t.[count] ELSE s.[n] END) ELSE t.[count] + s.[n] END
      WHEN NOT MATCHED THEN INSERT ([hour], [kind], [code], [count]) VALUES (s.[h], s.[k], s.[c], s.[n]);`, [JSON.stringify(rows)]);
}

/** Removes counters past their 90 days (the nightly job). */
export const OPS_COUNTER_DAYS = 90;
export async function pruneOpsCounters(pool: Pool, now = Date.now()): Promise<number> {
  const cut = new Date(now - OPS_COUNTER_DAYS * 86_400_000);
  return (await pool.query("DELETE FROM ops_counters WHERE [hour] < $1", [cut])).rowCount ?? 0;
}

// ---- Rates that raise alerts ------------------------------------------------------------------------------------------------------

export interface MinuteSample { requests: number; shed: number; errors: number }
/** Sustained shedding: more than 5% of requests shed in each of the last 10 minutes (each with at least 20 requests, so a quiet server's one refusal is not a rate). */
export const SHED_MINUTES = 10, SHED_SHARE = 0.05, MIN_REQUESTS = 20;
/** An error spike: in the last 5 minutes at least 20 server errors and at least 2% of requests. */
export const ERROR_MINUTES = 5, ERROR_MIN = 20, ERROR_SHARE = 0.02;

export function shedSustained(ring: readonly MinuteSample[]): boolean {
  const last = ring.slice(-SHED_MINUTES);
  return last.length === SHED_MINUTES && last.every(m => m.requests >= MIN_REQUESTS && m.shed / m.requests > SHED_SHARE);
}
export function errorSpike(ring: readonly MinuteSample[]): boolean {
  const last = ring.slice(-ERROR_MINUTES);
  const errors = last.reduce((a, m) => a + m.errors, 0), requests = last.reduce((a, m) => a + m.requests, 0);
  return errors >= ERROR_MIN && requests > 0 && errors / requests >= ERROR_SHARE;
}

/** The minute's totals out of a drained batch (the agent and console APIs together). */
export function minuteOf(d: Drained): MinuteSample {
  let requests = 0, shed = 0, errors = 0;
  for (const [k, n] of d.counts) {
    const [kind] = splitKey(k);
    if (kind === "requests") requests += n; else if (kind === "shed") shed += n; else if (kind === "http_5xx") errors += n;
  }
  return { requests, shed, errors };
}

export interface ReporterOptions {
  /** Where the counters are written, and where rate alerts are raised. */
  pool: Pool;
  /** Pools whose connection wait is sampled each second (name: pool). */
  sampled?: Record<string, Pool>;
  meter?: OpsMeter;
  log?: (message: string) => void;
  /** Tests: how long a minute is. */
  minuteMs?: number;
}

/**
 * Samples the pools' connection waits and the event loop's delay, and once a minute writes the meter to the database and checks the
 * shed and error rates. A failed write puts the counts back, so a brief database outage loses nothing.
 */
export class OpsReporter {
  private readonly meter: OpsMeter;
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private readonly waits = new Map<string, number[]>();
  private readonly ring: MinuteSample[] = [];
  private timers: NodeJS.Timeout[] = [];
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly o: ReporterOptions) { this.meter = o.meter ?? opsMeter; }

  start(): void {
    this.lag.enable();
    const second = setInterval(() => { for (const [name, pool] of Object.entries(this.o.sampled ?? {})) { const a = this.waits.get(name) ?? []; if (a.length < 120) a.push(pool.waitMs); this.waits.set(name, a); } }, 1_000);
    const minute = setInterval(() => { void this.flush(); }, this.o.minuteMs ?? 60_000);
    for (const t of [second, minute]) t.unref();
    this.timers = [second, minute];
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.flush();
    this.lag.disable();
  }

  /** Writes the minute (also called by tests and at shutdown). */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.once());
    return this.flushing;
  }

  private async once(): Promise<void> {
    for (const [name, samples] of this.waits) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      this.meter.gauge("g_db_wait_p95_ms", name, sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!);
      this.waits.set(name, []);
    }
    if (this.lag.count > 0) this.meter.gauge("g_loop_lag_p95_ms", "process", this.lag.percentile(95) / 1e6);
    this.lag.reset();
    const d = this.meter.drain();
    this.ring.push(minuteOf(d));
    if (this.ring.length > 15) this.ring.shift();
    try { await writeOpsCounters(this.o.pool, d); }
    catch (e) { this.meter.restore(d); this.o.log?.(`Writing operations counters failed: ${JSON.stringify(errorInfo(e))}`); }
    if (shedSustained(this.ring))
      await raiseSecurityAlertNow(this.o.pool, { kind: "ops_shed", signature: "ops:shed", title: "The server has been turning away more than 5% of agent requests for 10 minutes",
        detail: { minutes: SHED_MINUTES, share: SHED_SHARE } });
    if (errorSpike(this.ring))
      await raiseSecurityAlertNow(this.o.pool, { kind: "ops_errors", signature: "ops:errors", title: "The server is answering requests with errors (5xx) at an unusual rate",
        detail: { minutes: ERROR_MINUTES, errors: this.ring.slice(-ERROR_MINUTES).reduce((a, m) => a + m.errors, 0) } });
  }
}

// One simulated cabinet agent, modelled on the real one: agent/src/Cabinet.Agent.Core/Server/AgentConnection.cs,
// Connectivity.cs, ResultOutbox.cs, AgentApiClient.cs and Monitoring/EventQueue.cs (Protocol 1.1, merged October 2026).
// `protocol: "1.0"` keeps the agent as it was before 1.1, so a run can be compared before and after.
//
//                         1.0 (the agent before 1.1)                   1.1 (the agent now)
//   connection            HTTP/1.1 pool, idle 60 s, 10 min lifetime,   HTTP/2 if offered (RequestVersionOrLower), else HTTP/1.1
//                         no TCP keepalive                             idle 20 s; lifetime 23 h + 0-120 min; TCP keepalive 20 s
//                                                                      then 5 s probes; HTTP/2 ping every 20 s (10 s timeout)
//   long poll             25 s, client timeout 60 s, no ack;           ?ack= the previous poll's commands (lower-case, at most 50);
//                         commands run inside the poll loop            client timeout pollSeconds + 35 s; pollSeconds and
//                                                                      reconnectAfterMs honoured; one worker runs commands in turn
//                                                                      while polling goes on; a poll answered in under 1 s with
//                                                                      nothing waits 1 s
//   heartbeat             every 60 s                                   60 s until the server shows 1.1 (any pacing field), then
//                                                                      intervals.heartbeatSeconds or 300 s
//   results               8 attempts, then given up                    outbox, oldest first, until 2xx or 409; other 4xx dropped
//   events                100 per batch, back to back                  100 events / 256 KB; gzip only once the server showed 1.1
//                                                                      and the body is >= 1 KB (415: plain, for 24 h); halved on a
//                                                                      refusal, set aside after 5 refusals alone; paced only when
//                                                                      the server sets eventsPaceMs; after a reconnection the main
//                                                                      lane waits a random 0-120 s (security/agent status do not)
//   failures              per-loop exponential backoff (full jitter)   one shared state: network errors and 502/503/504 pause every
//                                                                      loop (one probe at a time, decorrelated jitter from 2 s,
//                                                                      capped at 5 min, 0-30 s after a reset of a live connection);
//                                                                      429 waits only in that loop; Retry-After honoured up to 10 min
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { AgentTransport, NetError, type HttpResponse } from "./transport.js";
import type { AgentLink } from "./link.js";

export type Protocol = "1.0" | "1.1";
export type Kind = "poll" | "heartbeat" | "events" | "result";

export interface AgentIdentity { index: number; cabinetId: string; keyPem: string; certPem: string }

export interface AgentConfig {
  protocol: Protocol;
  host: string;
  port: number;
  servername: string;
  ca: string;
  /** Monitored events per hour (Poisson, some in bursts). */
  eventsPerHour: number;
  /** This agent sends one event a second for the whole run (event-storm scenario). */
  storm: boolean;
  /** Multi-hour behaviours (daily drive report, failovers) run this many times faster. */
  timeCompression: number;
  /** How long the simulated install (the 5% long command) takes on the cabinet. */
  installMinutes: number;
  /** "auto" = as the agent does; "on" = gzip events >= 1 KB even before the server shows 1.1; "off" = never. */
  gzip: "auto" | "on" | "off";
  clockOffsetMs: number;
  /** Override the HTTP version offer: "auto" = h2 for 1.1, h1 for 1.0. */
  httpOffer: "auto" | "h1" | "h2";
  keepaliveSec: number;
}

/** What the agent tells the worker about. */
export interface AgentHooks {
  phase(): string;
  request(agent: SimAgent, kind: Kind, ms: number, outcome: string, extra?: { held?: boolean; bytes?: number }): void;
  contact(agent: SimAgent, at: number): void;
  received(agent: SimAgent, commandId: string, operation: string, at: number, repeat: boolean): void;
  resultDone(agent: SimAgent, commandId: string, outcome: "accepted" | "already" | "refused" | "abandoned"): void;
  count(key: string, n?: number): void;
  handshake(agent: SimAgent, reused: boolean, ms: number, protocol: string): void;
  bytes(agent: SimAgent, direction: "up" | "down", n: number): void;
  drained(agent: SimAgent, at: number): void;
  outputs: Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, Math.max(0, ms)));
const CAP_MS = 300_000;
const MAX_SERVER_WAIT_MS = 600_000;

/** Decorrelated jitter, as the agent's Backoff: min(cap, random(base, previous x 3)), base 2 s, cap 5 min. */
export class Backoff {
  private prev = 0;
  constructor(private readonly baseMs = 2_000, private readonly capMs = CAP_MS, private readonly rand: () => number = Math.random) {}
  next(): number {
    const lo = this.baseMs;
    const hi = Math.max(lo, (this.prev <= 0 ? lo : this.prev) * 3);
    this.prev = Math.min(this.capMs, lo + this.rand() * (hi - lo));
    return this.prev;
  }
  reset(): void { this.prev = 0; }
}

/** The 1.0 agent's Backoff: exponential with full jitter from 2 s, capped at 5 minutes. */
export class LegacyBackoff {
  attempt = 0;
  next(): number {
    const ceiling = Math.min(CAP_MS, 2_000 * Math.pow(2, Math.min(this.attempt, 20)));
    this.attempt++;
    return 1_000 + Math.random() * (ceiling - 1_000);
  }
  reset(): void { this.attempt = 0; }
}

export type FailureKind = "network" | "unavailable" | "quota" | "certificate" | "answered";
export function classify(r: HttpResponse | NetError): FailureKind {
  if (r instanceof NetError) return "network";
  if (r.status === 401) return "certificate";
  if (r.status === 429) return "quota";
  if (r.status === 502 || r.status === 503 || r.status === 504) return "unavailable";
  return "answered";
}

/**
 * The shared connectivity state (Connectivity.cs). While the server is unreachable one request at a time probes it
 * (polls and heartbeats may; results and events only send once connected), at the pace of one backoff.
 */
export class Connectivity {
  connected = false;
  private everConnected = false;
  private probing = false;
  private failedAt = 0;
  private backoffUntil = 0;
  serverWaitUntil = 0;
  private signal!: Promise<void>;
  private fire!: () => void;
  onConnected: ((reconnected: boolean) => void) | null = null;
  constructor(private readonly backoff = new Backoff(), private readonly rand: () => number = Math.random, private readonly resetJitterMs = 30_000,
    private readonly now: () => number = Date.now) { this.renew(); }

  private renew(): void { this.signal = new Promise(r => { this.fire = r; }); }
  private changed(): void { const f = this.fire; this.renew(); f(); }

  /** Waits until this loop may send; returns a release function (which frees the probe slot when this was the probe). */
  async enter(stopped: () => boolean, maxBackoffMs?: number, probe = true): Promise<(() => void) | null> {
    for (;;) {
      if (stopped()) return null;
      const now = this.now();
      let wait: number;
      if (this.connected) {
        if (this.serverWaitUntil <= now) return () => undefined;
        wait = this.serverWaitUntil - now;
      } else if (probe && !this.probing) {
        let until = this.backoffUntil;
        if (maxBackoffMs !== undefined && until > this.failedAt + maxBackoffMs) until = this.failedAt + maxBackoffMs;
        until = Math.max(until, this.serverWaitUntil);
        if (until <= now) { this.probing = true; return () => { this.probing = false; this.changed(); }; }
        wait = until - now;
      } else wait = 5_000; // wait for "connected" (re-checked so a stopped agent can leave)
      await Promise.race([this.signal, sleep(Math.min(wait, 5_000))]);
    }
  }

  reached(): void {
    if (this.connected) return;
    const reconnected = this.everConnected;
    this.connected = this.everConnected = true;
    this.backoff.reset();
    this.backoffUntil = 0;
    this.changed();
    this.onConnected?.(reconnected);
  }

  /** Returns the classification; network and 502/503/504 put every loop on hold, quota and other answers do not. */
  failed(kind: FailureKind, retryAfterMs: number | null): FailureKind {
    if (kind === "answered" || kind === "quota") this.reached();
    else if (kind === "network" || kind === "unavailable") this.down(kind === "network", retryAfterMs);
    return kind;
  }

  serverAskedToWait(ms: number): void { this.down(false, ms); }

  private down(networkReset: boolean, serverWaitMs: number | null): void {
    const now = this.now();
    const lost = this.connected;
    this.connected = false;
    this.failedAt = now;
    let b = this.backoff.next();
    // A live connection that was reset: everyone behind the same failure sees it at once, so the first retry is spread.
    if (lost && networkReset) b = this.rand() * this.resetJitterMs;
    this.backoffUntil = now + b;
    if (serverWaitMs !== null) this.serverWaitUntil = Math.max(this.serverWaitUntil, now + Math.min(MAX_SERVER_WAIT_MS, Math.max(0, serverWaitMs)));
    this.changed();
  }

  /** Lets every waiter re-check (the agent is stopping). */
  wake(): void { this.changed(); }
}

/** Retry-After in ms: delta seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d{1,6}$/.test(value.trim())) return Number(value.trim()) * 1000;
  // Only the IMF-fixdate form (RFC 9110), so odd values such as "-1" are not read as a date.
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value.trim())) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

const clamp = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : null;

interface QueuedEvent { id: string; json: string; bytes: number; failures: number }

/** Builds one batch from a lane: at most maxEvents and maxBytes of JSON (one event always goes, so it can be refused alone). */
export function takeBatch(priority: QueuedEvent[], normal: QueuedEvent[], maxEvents: number, maxBytes: number): QueuedEvent[] {
  const out: QueuedEvent[] = [];
  let bytes = 12; // {"events":[]}
  for (const q of [priority, normal])
    for (const e of q) {
      if (out.length >= maxEvents) return out;
      if (out.length > 0 && bytes + e.bytes + 1 > maxBytes) return out;
      out.push(e);
      bytes += e.bytes + 1;
    }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIN_QUEUE_CAP = 5_000;
const PRIORITY_QUEUE_CAP = 1_000;
const MAX_QUEUED_COMMANDS = 200;
const MAX_EVENT_FAILURES = 5;

export class SimAgent {
  readonly transport: AgentTransport;
  private readonly link11: Connectivity;
  private stopped = false;
  private server11 = false;
  private pollSeconds = 25;
  private heartbeatSeconds11: number | null = null;
  private eventsPaceMs = 0;
  private readonly inFlight = new Set<string>();
  private readonly work: { id: string; raw: Record<string, unknown> }[] = [];
  private workSignal: (() => void) | null = null;
  /** The result outbox: pending results oldest first, and the delivered ones kept to answer a repeat offer. */
  private readonly outbox: { id: string; result: Record<string, unknown> }[] = [];
  private readonly delivered = new Map<string, Record<string, unknown>>();
  private outboxSignal: (() => void) | null = null;
  private readonly seen = new Map<string, number>(); // 1.0 replay store
  private readonly priority: QueuedEvent[] = [];
  private readonly normal: QueuedEvent[] = [];
  private readonly recentEvents: QueuedEvent[] = [];
  private recordId = Math.floor(Math.random() * 1e6);
  private gzipRefusedAt = 0;
  private flushNotBefore = 0;
  private lastServer: { server: number; local: number } | null = null;
  private lastHealthAt = 0;
  private nextDrivesAt: number;
  private readonly startedAt = Date.now();
  private firewallPublic = true;
  lastContact = 0;
  /** Set while the worker wants to know when the event backlog is empty again (after an outage). */
  drainWatch = false;
  readonly linkClass: string;

  constructor(readonly id: AgentIdentity, readonly link: AgentLink, private readonly cfg: AgentConfig, private readonly hooks: AgentHooks) {
    this.linkClass = link.cls.name;
    const day = 86_400_000 / cfg.timeCompression;
    this.nextDrivesAt = Date.now() + Math.random() * day;
    this.link11 = new Connectivity();
    this.link11.onConnected = reconnected => {
      if (reconnected) { this.flushNotBefore = Date.now() + Math.random() * 120_000; hooks.count("reconnected"); }
    };
    const offer = cfg.httpOffer === "auto" ? (cfg.protocol === "1.1" ? "h2" : "h1") : cfg.httpOffer;
    this.transport = new AgentTransport({ host: cfg.host, port: cfg.port, servername: cfg.servername, ca: cfg.ca, cert: id.certPem, key: id.keyPem, link, offer,
      idleTimeoutMs: cfg.protocol === "1.0" ? 60_000 : 20_000, lifetimeMs: cfg.protocol === "1.0" ? 600_000 : (23 * 60 + Math.random() * 120) * 60_000,
      keepaliveSec: cfg.keepaliveSec, h2PingMs: cfg.protocol === "1.1" ? 20_000 : 0,
      onHandshake: (reused, ms, p) => hooks.handshake(this, reused, ms, p), onBytes: (d, n) => hooks.bytes(this, d, n) });
  }

  get queued(): number { return this.priority.length + this.normal.length; }
  get pendingResults(): number { return this.outbox.length; }
  get pendingResultIds(): string[] { return this.outbox.map(o => o.id); }
  private localNow(): number { return Date.now() + this.cfg.clockOffsetMs; }
  private iso(t = this.localNow()): string { return new Date(t).toISOString(); }
  private v11(): boolean { return this.cfg.protocol === "1.1"; }
  private get heartbeatMs(): number { return (!this.v11() || !this.server11 ? 60 : this.heartbeatSeconds11 ?? 300) * 1000; }

  async run(startDelayMs: number): Promise<void> {
    await sleep(startDelayMs);
    if (this.stopped) return;
    const loops = this.v11()
      ? [this.heartbeatLoop11(), this.pollLoop11(), this.workerLoop11(), this.outboxLoop11(), this.eventLoop11(), this.monitorLoop()]
      : [this.heartbeatLoop10(), this.pollLoop10(), this.eventLoop10(), this.monitorLoop()];
    await Promise.all(loops);
  }

  stop(): void {
    this.stopped = true;
    this.outboxSignal?.();
    this.workSignal?.();
    this.link11.wake();
    this.transport.stop();
  }

  // ---- Requests --------------------------------------------------------------------------------

  private async send(kind: Kind, method: "GET" | "POST", path: string, body: Buffer | undefined, timeoutMs: number, encoding?: string): Promise<HttpResponse | NetError> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "MashuraCabinetAgent/1 (load)" };
    if (body !== undefined) { headers["content-type"] = "application/json"; if (encoding) headers["content-encoding"] = encoding; }
    const t = performance.now();
    try {
      const r = await this.transport.request(method, path, headers, body, timeoutMs);
      const ms = performance.now() - t;
      let held = false;
      if (r.status >= 200 && r.status < 300) {
        try {
          const j = JSON.parse(r.body.toString()) as { serverTime?: string; commands?: unknown[] };
          const s = Date.parse(j.serverTime ?? "");
          if (Number.isFinite(s)) this.lastServer = { server: s, local: this.localNow() };
          held = kind === "poll" && Array.isArray(j.commands) && j.commands.length === 0;
        } catch { /* checked by the caller */ }
      }
      this.hooks.request(this, kind, ms, String(r.status), { held, bytes: body?.length ?? 0 });
      return r;
    } catch (e) {
      const err = e instanceof NetError ? e : new NetError("ERR", (e as Error).message);
      // Connections torn down because the run ended are not failures.
      if (err.code !== "ESTOPPED" && !this.stopped) this.hooks.request(this, kind, performance.now() - t, `net:${err.code}`);
      return err;
    }
  }

  private json(v: unknown): Buffer { return Buffer.from(JSON.stringify(v)); }

  private contact(): void {
    const now = Date.now();
    this.hooks.contact(this, now);
    this.lastContact = now;
  }

  /** Records a failure with the shared state (1.1) and counts refusals. */
  private failed11(r: HttpResponse | NetError): FailureKind {
    const kind = classify(r);
    const ra = r instanceof NetError ? null : retryAfterMs(r.headers["retry-after"]);
    if (!(r instanceof NetError) && kind !== "answered") this.hooks.count(`refused.${r.status}${ra === null ? "" : ".retryAfter"}`);
    return this.link11.failed(kind, ra);
  }

  /** LocalWait: the loop's own backoff, capped, but at least Retry-After (up to 10 min). */
  private localWait(r: HttpResponse | NetError, b: Backoff, capMs?: number): number {
    let w = b.next();
    if (capMs !== undefined && w > capMs) w = capMs;
    const ra = r instanceof NetError ? null : retryAfterMs(r.headers["retry-after"]);
    if (ra !== null) w = Math.max(w, Math.min(ra, MAX_SERVER_WAIT_MS));
    return w;
  }

  private applyIntervals(intervals: unknown): void {
    if (typeof intervals !== "object" || intervals === null) return;
    const i = intervals as { heartbeatSeconds?: unknown; pollSeconds?: unknown; eventsPaceMs?: unknown };
    if (!this.server11) this.hooks.count("server11.detected");
    this.server11 = true;
    this.heartbeatSeconds11 = clamp(i.heartbeatSeconds, 60, 900);
    const p = clamp(i.pollSeconds, 15, 110);
    if (p !== null) this.pollSeconds = p;
    this.eventsPaceMs = clamp(i.eventsPaceMs, 0, 60_000) ?? 0;
  }

  // ---- Protocol 1.1 ----------------------------------------------------------------------------

  private async pollLoop11(): Promise<void> {
    const local = new Backoff();
    let ack: string[] = [];
    while (!this.stopped) {
      const release = await this.link11.enter(() => this.stopped);
      if (!release) return;
      const started = Date.now();
      const sent = ack.slice(0, 50);
      const path = sent.length ? `/agent/v1/commands?ack=${sent.join(",")}` : "/agent/v1/commands";
      const r = await this.send("poll", "GET", path, undefined, this.pollSeconds * 1000 + 35_000);
      release();
      if (this.stopped) return;
      const body = this.pollAnswer(r);
      if (!body) {
        const kind = this.failed11(r);
        if (kind === "network" || kind === "unavailable") continue;
        await sleep(this.localWait(r, local));
        continue;
      }
      this.link11.reached();
      local.reset();
      this.contact();
      ack = this.takeCommands(body.commands);
      const ps = clamp(body.pollSeconds, 15, 110);
      if (ps !== null) { if (!this.server11) this.hooks.count("server11.detected"); this.server11 = true; this.pollSeconds = ps; }
      const ra = clamp(body.reconnectAfterMs, 0, 600_000);
      if (ra !== null) { this.hooks.count("poll.reconnectAfterMs"); this.link11.serverAskedToWait(ra); }
      else if (body.commands.length === 0 && Date.now() - started < 1_000) await sleep(1_000);
    }
  }

  private pollAnswer(r: HttpResponse | NetError): { commands: unknown[]; pollSeconds?: unknown; reconnectAfterMs?: unknown } | null {
    if (r instanceof NetError || r.status !== 200) return null;
    try {
      const j = JSON.parse(r.body.toString()) as { commands?: unknown; pollSeconds?: unknown; reconnectAfterMs?: unknown };
      if (typeof j === "object" && j !== null && Array.isArray(j.commands)) return j as { commands: unknown[] };
    } catch { /* counted below */ }
    this.hooks.count("poll.badAnswer");
    return null;
  }

  /** TakeCommands: decides what to acknowledge next poll and hands new commands to the worker. */
  private takeCommands(commands: unknown[]): string[] {
    const ack: string[] = [];
    const now = Date.now();
    for (const raw of commands) {
      const c = raw as Record<string, unknown>;
      const idText = typeof c === "object" && c !== null && typeof c["commandId"] === "string" && UUID.test(c["commandId"]) ? c["commandId"] : null;
      if (!idText) { this.hooks.count("command.malformed"); continue; }
      const id = idText.toLowerCase();
      const op = typeof c["operation"] === "string" ? c["operation"] : "?";
      const pending = this.outbox.some(o => o.id === id);
      const repeat = this.inFlight.has(id) || pending || this.delivered.has(id);
      this.hooks.received(this, id, op, now, repeat);
      if (this.inFlight.has(id) || pending) { ack.push(id); continue; }
      const done = this.delivered.get(id);
      if (done) { this.hooks.count("commands.answeredFromOutbox"); this.addResult(id, done); ack.push(id); continue; }
      if (this.inFlight.size >= MAX_QUEUED_COMMANDS) continue; // not acknowledged: offered again later
      this.inFlight.add(id);
      ack.push(id);
      this.work.push({ id, raw: c });
      this.workSignal?.();
    }
    return ack;
  }

  /** One command at a time, as the agent's worker; polling goes on meanwhile. */
  private async workerLoop11(): Promise<void> {
    while (!this.stopped) {
      const item = this.work.shift();
      if (!item) { await new Promise<void>(r => { this.workSignal = r; setTimeout(r, 5_000); }); this.workSignal = null; continue; }
      const result = await this.execute(item.raw);
      this.inFlight.delete(item.id);
      if (this.stopped) return;
      this.addResult(item.id, result);
    }
  }

  private addResult(id: string, result: Record<string, unknown>): void {
    this.delivered.delete(id);
    this.outbox.push({ id, result });
    this.outboxSignal?.();
  }

  private async outboxLoop11(): Promise<void> {
    const local = new Backoff();
    while (!this.stopped) {
      const next = this.outbox[0];
      if (!next) { await new Promise<void>(r => { this.outboxSignal = r; setTimeout(r, 5_000); }); this.outboxSignal = null; continue; }
      const release = await this.link11.enter(() => this.stopped, undefined, false);
      if (!release) return;
      const r = await this.send("result", "POST", "/agent/v1/results", this.json(next.result), 60_000);
      release();
      if (this.stopped) return;
      const settle = (outcome: "accepted" | "already" | "refused"): void => {
        this.outbox.shift();
        this.delivered.set(next.id, next.result);
        if (this.delivered.size > 1000) this.delivered.delete(this.delivered.keys().next().value!);
        this.hooks.resultDone(this, next.id, outcome);
      };
      if (!(r instanceof NetError) && r.status >= 200 && r.status < 300) { this.link11.reached(); local.reset(); settle("accepted"); continue; }
      const kind = this.failed11(r);
      if (!(r instanceof NetError) && r.status === 409) { settle("already"); continue; }
      if (kind === "answered" && !(r instanceof NetError) && r.status >= 400 && r.status < 500) { settle("refused"); continue; }
      if (kind === "answered" || kind === "quota") await sleep(this.localWait(r, local));
    }
  }

  private async heartbeatLoop11(): Promise<void> {
    const local = new Backoff();
    while (!this.stopped) {
      const release = await this.link11.enter(() => this.stopped, this.heartbeatMs);
      if (!release) return;
      const body = this.heartbeatBody();
      const r = await this.send("heartbeat", "POST", "/agent/v1/heartbeat", this.json(body), 60_000);
      release();
      if (this.stopped) return;
      let next: number;
      if (!(r instanceof NetError) && r.status === 200) {
        this.link11.reached();
        local.reset();
        this.contact();
        if (body["health"]) this.lastHealthAt = Date.now();
        try { this.applyIntervals((JSON.parse(r.body.toString()) as { intervals?: unknown }).intervals); } catch { this.hooks.count("heartbeat.badJson"); }
        next = this.heartbeatMs;
      } else {
        const kind = this.failed11(r);
        if (kind === "network" || kind === "unavailable") continue; // the shared state paces the retry
        next = this.localWait(r, local, this.heartbeatMs);
      }
      await this.sleepOrStop(next);
    }
  }

  private async eventLoop11(): Promise<void> {
    const local = new Backoff();
    let maxCount = 100;
    let failingHead: QueuedEvent | null = null;
    let failuresAlone = 0;
    while (!this.stopped) {
      if (this.queued === 0) {
        if (this.drainWatch) { this.drainWatch = false; this.hooks.drained(this, Date.now()); }
        await this.sleepOrStop(15_000);
        continue;
      }
      const hold = this.flushNotBefore - Date.now();
      if (this.priority.length === 0 && hold > 0) { await this.sleepOrStop(Math.min(hold, 15_000)); continue; }
      const lane = this.priority.length > 0 ? this.priority : this.normal;
      const batch = takeBatch(lane === this.priority ? this.priority : [], lane === this.normal ? this.normal : [], maxCount, 256 * 1024);
      const release = await this.link11.enter(() => this.stopped, undefined, false);
      if (!release) return;
      if (this.priority.length === 0 && this.flushNotBefore > Date.now()) { release(); continue; }
      const plain = Buffer.from(`{"events":[${batch.map(e => e.json).join(",")}]}`);
      const gzipOk = this.cfg.gzip !== "off" && (this.server11 || this.cfg.gzip === "on") && Date.now() - this.gzipRefusedAt > 86_400_000 && plain.length >= 1024;
      let r = await this.send("events", "POST", "/agent/v1/events", gzipOk ? gzipSync(plain) : plain, 60_000, gzipOk ? "gzip" : undefined);
      if (gzipOk && !(r instanceof NetError) && r.status === 415) {
        this.gzipRefusedAt = Date.now();
        this.hooks.count("events.gzipRefused415");
        r = await this.send("events", "POST", "/agent/v1/events", plain, 60_000);
      }
      release();
      if (this.stopped) return;
      let wait: number | null = null;
      if (!(r instanceof NetError) && r.status >= 200 && r.status < 300) {
        this.link11.reached();
        if (gzipOk) this.hooks.count("events.gzipBatches");
        this.remove(batch);
        this.hooks.count("events.sent", batch.length);
        local.reset();
        maxCount = Math.min(100, maxCount * 2);
        failingHead = null; failuresAlone = 0;
        if (this.queued > 0 && this.eventsPaceMs > 0) wait = this.eventsPaceMs;
      } else {
        const kind = this.failed11(r);
        if (kind === "quota") wait = this.localWait(r, local);
        else if (kind === "answered") {
          maxCount = Math.max(1, Math.floor(batch.length / 2));
          if (batch.length === 1) {
            failuresAlone = failingHead === batch[0] ? failuresAlone + 1 : 1;
            failingHead = batch[0]!;
            if (failuresAlone >= MAX_EVENT_FAILURES) { this.remove(batch); this.hooks.count("events.setAside"); failingHead = null; failuresAlone = 0; }
          }
          if (r instanceof NetError || r.status !== 413) wait = this.localWait(r, local);
        }
      }
      if (wait !== null) await sleep(wait);
    }
  }

  // ---- Protocol 1.0 (the agent before 1.1) -----------------------------------------------------

  private async pollLoop10(): Promise<void> {
    const backoff = new LegacyBackoff();
    while (!this.stopped) {
      const r = await this.send("poll", "GET", "/agent/v1/commands", undefined, 60_000);
      if (this.stopped) return;
      let commands: unknown[] | null = null;
      if (!(r instanceof NetError) && r.status === 200) {
        try { const j = JSON.parse(r.body.toString()) as { commands?: unknown }; if (Array.isArray(j.commands)) commands = j.commands; } catch { /* below */ }
      }
      if (!commands) { await sleep(backoff.next()); continue; }
      backoff.reset();
      for (const raw of commands) {
        const c = raw as Record<string, unknown>;
        if (typeof c !== "object" || c === null || typeof c["commandId"] !== "string" || !UUID.test(c["commandId"])) { this.hooks.count("command.malformed"); continue; }
        const id = c["commandId"].toLowerCase();
        const repeat = this.seen.has(id);
        this.hooks.received(this, id, String(c["operation"]), Date.now(), repeat);
        if (repeat) continue; // the replay store refuses a repeat
        this.seen.set(id, Date.now());
        if (this.seen.size > 2000) for (const [k, v] of this.seen) if (Date.now() - v > 3_600_000) this.seen.delete(k);
        // The 1.0 loop runs each command, and posts its result, before it polls again.
        const result = await this.execute(c);
        if (this.stopped) return;
        await this.postResult10(id, result);
      }
    }
  }

  /** PostResultAsync: 8 attempts with backoff, then the result is given up. */
  private async postResult10(id: string, result: Record<string, unknown>): Promise<void> {
    const backoff = new LegacyBackoff();
    for (let attempt = 0; attempt < 8 && !this.stopped; attempt++) {
      const r = await this.send("result", "POST", "/agent/v1/results", this.json(result), 60_000);
      if (!(r instanceof NetError)) {
        if (r.status === 200) { this.hooks.resultDone(this, id, "accepted"); return; }
        if (r.status === 409) { this.hooks.resultDone(this, id, "already"); return; }
        if (r.status === 400 || r.status === 404) { this.hooks.resultDone(this, id, "refused"); return; }
      }
      await sleep(backoff.next());
    }
    if (!this.stopped) this.hooks.resultDone(this, id, "abandoned");
  }

  private async heartbeatLoop10(): Promise<void> {
    const backoff = new LegacyBackoff();
    while (!this.stopped) {
      const body = this.heartbeatBody();
      const r = await this.send("heartbeat", "POST", "/agent/v1/heartbeat", this.json(body), 60_000);
      if (this.stopped) return;
      if (!(r instanceof NetError) && r.status === 200) {
        backoff.reset();
        this.lastHealthAt = Date.now();
        this.contact(); // a 1.0 server records presence from the heartbeat only
        await this.sleepOrStop(60_000);
      } else await sleep(backoff.next());
    }
  }

  private async eventLoop10(): Promise<void> {
    const backoff = new LegacyBackoff();
    while (!this.stopped) {
      if (this.queued === 0) {
        if (this.drainWatch) { this.drainWatch = false; this.hooks.drained(this, Date.now()); }
        await this.sleepOrStop(15_000);
        continue;
      }
      const batch = this.normal.slice(0, 100);
      const r = await this.send("events", "POST", "/agent/v1/events", Buffer.from(`{"events":[${batch.map(e => e.json).join(",")}]}`), 60_000);
      if (this.stopped) return;
      if (!(r instanceof NetError) && r.status === 200) { this.remove(batch); this.hooks.count("events.sent", batch.length); backoff.reset(); continue; }
      if (!(r instanceof NetError) && r.status === 400) { this.remove(batch); this.hooks.count("events.droppedMalformed", batch.length); continue; }
      await sleep(backoff.next());
    }
  }

  // ---- Shared: running a command, the heartbeat body, the monitors ------------------------------

  private async execute(c: Record<string, unknown>): Promise<Record<string, unknown>> {
    const commandId = String(c["commandId"]);
    const op = typeof c["operation"] === "string" ? c["operation"] : "?";
    const started = this.iso();
    if (c["cabinetId"] !== this.id.cabinetId)
      return { commandId, status: "rejected", startedAt: started, finishedAt: started, error: { code: "wrong_cabinet", message: "not this cabinet" } };
    if (typeof c["expiresAt"] !== "string" || !(Date.parse(c["expiresAt"]) > this.localNow()))
      return { commandId, status: "rejected", startedAt: started, finishedAt: started, error: { code: "expired", message: "arrived after expiry" } };
    await sleep(this.runtimeMs(op));
    return { commandId, status: "succeeded", startedAt: started, finishedAt: this.iso(), output: this.hooks.outputs[op] ?? this.hooks.outputs["system.info"] };
  }

  private runtimeMs(op: string): number {
    if (op === "eventlog.query") return 2_000 + Math.random() * 18_000;
    if (op === "system.checkHealth") return this.cfg.installMinutes * 60_000 * (0.8 + Math.random() * 0.4);
    if (op === "system.info") return 200 + Math.random() * 1_200;
    return 500 + Math.random() * 1_500;
  }

  private heartbeatBody(): Record<string, unknown> {
    const now = Date.now();
    const skew = this.lastServer ? Math.max(-86_400, Math.min(86_400, Math.round((this.lastServer.local - this.lastServer.server) / 100) / 10)) : undefined;
    // A load sample at most every 15 minutes in 1.1 (spec "Presence"); with every heartbeat in 1.0.
    const healthDue = !this.v11() || now - this.lastHealthAt >= 15 * 60_000;
    let health: Record<string, unknown> | undefined;
    if (healthDue) {
      health = { cpuPercent: Math.floor(Math.random() * 60), memoryUsedPercent: 40 + Math.floor(Math.random() * 30), diskFreePercent: 30 + Math.floor(Math.random() * 40) };
      if (now >= this.nextDrivesAt) {
        this.nextDrivesAt = now + 86_400_000 / this.cfg.timeCompression;
        health["drives"] = [{ model: "Load SSD 500GB", serialNumber: `LOAD-${this.id.cabinetId.slice(0, 8).toUpperCase()}`, health: "healthy", predictFailure: false,
          temperatureCelsius: 35 + Math.floor(Math.random() * 10), powerOnHours: 9000, reallocatedSectors: 0, pendingSectors: 0, uncorrectableErrors: 0, wearPercent: 8 }];
        this.hooks.count("heartbeat.drives");
      }
    }
    // Once in a long while someone switches a firewall profile (the server then compares with the policy).
    if (Math.random() < 0.002) this.firewallPublic = !this.firewallPublic;
    return { agentVersion: this.v11() ? "1.1.0" : "1.0.0", uptimeSeconds: Math.floor((now - this.startedAt) / 1000) + 3600, readOnlyMode: false,
      ...(skew !== undefined ? { clockSkewSeconds: skew } : {}), firewallProfiles: { domain: true, private: true, public: this.firewallPublic },
      timeZoneId: "W. Europe Standard Time", ...(health ? { health } : {}) };
  }

  private async sleepOrStop(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!this.stopped && Date.now() < end) await sleep(Math.min(5_000, end - Date.now()));
  }

  /** The monitors: Poisson arrivals at eventsPerHour, a fifth of them in bursts of 2 to 10 (a crash loop, a flapping device). */
  private async monitorLoop(): Promise<void> {
    if (this.cfg.storm) {
      while (!this.stopped) { this.enqueue(this.makeEvent()); await sleep(1_000); }
      return;
    }
    if (this.cfg.eventsPerHour <= 0) return;
    while (!this.stopped) {
      await this.sleepOrStop(-Math.log(1 - Math.random()) * 3_600_000 / this.cfg.eventsPerHour);
      if (this.stopped) return;
      const n = Math.random() < 0.2 ? 2 + Math.floor(Math.random() * 9) : 1;
      for (let i = 0; i < n; i++) this.enqueue(this.makeEvent());
    }
  }

  /** A backlog as if the cabinet had been cut off for `hours` (oldest first, timestamps in the past). */
  preload(hours: number): void {
    const n = Math.min(MAIN_QUEUE_CAP, Math.round(this.cfg.eventsPerHour * hours));
    const now = this.localNow();
    for (let i = 0; i < n; i++) this.enqueue(this.makeEvent(now - (hours * 3_600_000 * (n - i)) / n));
  }

  private makeEvent(at = this.localNow()): QueuedEvent {
    // About 3% are the same event detected again (a re-read log record, a repeated watcher report): same eventId.
    if (this.recentEvents.length > 0 && Math.random() < 0.03) {
      this.hooks.count("events.duplicateId");
      const d = this.recentEvents[Math.floor(Math.random() * this.recentEvents.length)]!;
      return { ...d, failures: 0 };
    }
    const u = Math.random();
    const occurredAt = new Date(at).toISOString();
    const eventId = randomUUID();
    this.recordId++;
    let ev: Record<string, unknown>;
    if (u < 0.5) {
      const pick = [[7031, "Service Control Manager", "The Print Spooler service terminated unexpectedly."], [1000, "Application Error", "Faulting application name: CabinetClient.exe, version: 4.2.1.0"],
        [10016, "DistributedCOM", "The application-specific permission settings do not grant Local Activation permission."], [41, "Kernel-Power", "The system has rebooted without cleanly shutting down first."]][Math.floor(Math.random() * 4)]!;
      ev = { eventId, kind: "error", occurredAt, severityHint: Math.random() < 0.2 ? "major" : "minor",
        source: { log: pick[0] === 1000 ? "Application" : "System", source: pick[1], eventId: pick[0], level: "error", recordId: this.recordId },
        detail: { message: pick[2], fields: { param1: "Print Spooler", param2: "1", count: String(1 + Math.floor(Math.random() * 3)) } } };
    } else if (u < 0.7) {
      ev = { eventId, kind: "change", occurredAt, severityHint: "minor",
        source: { log: "System", source: "Microsoft-Windows-WindowsUpdateClient", eventId: 19, level: "information", recordId: this.recordId },
        detail: { message: "Installation Successful: Windows successfully installed the following update: 2026-10 Cumulative Update for Windows 10 Version 21H2 (KB5050011)" } };
    } else if (u < 0.8) {
      ev = { eventId, kind: "service", occurredAt, severityHint: "minor", detail: { message: "The watched service was restarted.", fields: { service: "Spooler", change: "restarted" } } };
    } else if (u < 0.9) {
      const state = Math.random() < 0.5 ? "disconnected" : "recovered";
      ev = { eventId, kind: "scanner", occurredAt, severityHint: state === "disconnected" ? "major" : "minor",
        device: { hardwareIds: ["USB\\VID_1234&PID_5678"], deviceInstanceId: "USB\\VID_1234&PID_5678\\6&2A1B3C4D&0&2", name: "Fingerprint Reader", state },
        detail: { message: state === "disconnected" ? "The fingerprint scanner was disconnected." : "The fingerprint scanner is working again.", fields: { usbPort: "Port_#0002.Hub_#0003" } } };
    } else if (u < 0.95) {
      ev = { eventId, kind: "firewall_changed", occurredAt, severityHint: "minor", detail: { message: "Rule Sync TCP 1433 created." } };
    } else if (u < 0.98) {
      ev = { eventId, kind: "smart_warning", occurredAt, severityHint: "major", detail: { message: "Drive predicts failure.", fields: { model: "NVMe 256GB" } } };
    } else {
      ev = { eventId, kind: "agent_status", occurredAt, severityHint: "minor", detail: { message: "The agent restarted after an update.", fields: { reason: "restart" } } };
    }
    const json = JSON.stringify(ev);
    return { id: eventId, json, bytes: Buffer.byteLength(json), failures: 0 };
  }

  private enqueue(e: QueuedEvent): void {
    // 1.1 keeps security and agent-status events in their own lane, sent first.
    const isPriority = this.v11() && (e.json.includes('"kind":"security"') || e.json.includes('"kind":"agent_status"'));
    const q = isPriority ? this.priority : this.normal;
    q.push(e);
    if (q.length > (isPriority ? PRIORITY_QUEUE_CAP : MAIN_QUEUE_CAP)) { q.shift(); this.hooks.count("events.droppedQueueFull"); }
  }

  private remove(batch: QueuedEvent[]): void {
    const ids = new Set(batch);
    for (const q of [this.priority, this.normal]) {
      let w = 0;
      for (let i = 0; i < q.length; i++) if (!ids.has(q[i]!)) q[w++] = q[i]!;
      q.length = w;
    }
    for (const e of batch) { this.recentEvents.push(e); if (this.recentEvents.length > 20) this.recentEvents.shift(); }
  }
}

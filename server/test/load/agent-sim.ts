// One simulated cabinet agent, modelled on the real agent (agent/src/Cabinet.Agent.Core/Server/AgentConnection.cs) and
// on Protocol 1.1 (docs/spec/03-protocol.md "Protocol 1.1"). `protocol: "1.0"` keeps the behaviour of the agent as it
// was before 1.1, so a run can be compared before and after.
//
//                         1.0 (today's agent)                         1.1
//   connection            HTTP/1.1 pool, idle 60 s, 10 min lifetime,   one HTTP/2 connection if offered (else HTTP/1.1
//                         no TCP keepalive                             keep-alive, idle 20 s), keepalive 20 s, 24 h lifetime
//   long poll             25 s, no ack; commands run one after         ?ack= of the last poll's commands; pollSeconds and
//                         another inside the poll loop                 reconnectAfterMs honoured; commands run beside it
//   heartbeat             every 60 s, load sample every time           server-directed (default 300 s), load sample every 15 min
//   results               8 attempts, then given up                    on-disk outbox, posted until accepted (or 409)
//   events                100 per batch, one after another             100 / 256 KB, gzip when accepted, paced drain,
//                                                                      halved on 413, a failing first event set aside,
//                                                                      a priority queue for security / agent status
//   failures              per-loop exponential backoff (full jitter)   one shared connectivity state, decorrelated jitter
//                                                                      capped at 5 min, Retry-After honoured
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
  gzip: "auto" | "on" | "off";
  eventQueueCap: number;
  /** Pause between backlog batches when the server sets none (1.1). */
  eventsPaceMs: number;
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

/** Decorrelated jitter (min(cap, random(base, previous x 3))), shared by every loop of a 1.1 agent. */
export class Connectivity {
  online = false;
  notBefore = 0;
  private prev = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly baseMs = 1_000, private readonly capMs = CAP_MS, private readonly rand: () => number = Math.random) {}

  /** A request failed on the network. Escalates the wait only once per attempt window, however many loops failed. */
  failed(now = Date.now()): number {
    this.online = false;
    if (now < this.notBefore) return this.notBefore - now;
    const hi = Math.max(this.baseMs, this.prev * 3);
    const next = Math.min(this.capMs, this.baseMs + this.rand() * (hi - this.baseMs));
    this.prev = next;
    this.notBefore = now + next;
    return next;
  }

  ok(): void {
    this.prev = 0;
    if (this.online) return;
    this.online = true;
    const w = this.waiters; this.waiters = [];
    for (const f of w) f();
  }

  /** Retry-After or reconnectAfterMs: no request before then. */
  defer(ms: number, now = Date.now()): void { this.notBefore = Math.max(this.notBefore, now + ms); }

  async gate(stopped: () => boolean): Promise<void> {
    while (!stopped() && Date.now() < this.notBefore) await sleep(Math.min(5_000, this.notBefore - Date.now()));
  }

  waitOnline(): Promise<void> { return this.online ? Promise.resolve() : new Promise(r => this.waiters.push(r)); }
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

/** Builds one batch: priority events first, at most maxEvents and maxBytes of JSON. */
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

export class SimAgent {
  readonly transport: AgentTransport;
  private readonly conn = new Connectivity();
  private stopped = false;
  private pollSeconds = 25;
  private heartbeatSeconds: number;
  private eventsPace: number | null = null;
  private acks: string[] = [];
  private readonly seen = new Map<string, { at: number; result: unknown | null }>();
  private readonly outbox: { result: Record<string, unknown>; attempts: number }[] = [];
  private outboxSignal: (() => void) | null = null;
  private readonly priority: QueuedEvent[] = [];
  private readonly normal: QueuedEvent[] = [];
  private readonly recentEvents: QueuedEvent[] = [];
  private recordId = Math.floor(Math.random() * 1e6);
  private batchMax = 100;
  private gzipState: "unknown" | "yes" | "no";
  private lastServer: { server: number; local: number } | null = null;
  private lastHealthAt = 0;
  private nextDrivesAt: number;
  private readonly startedAt = Date.now();
  private firewallPublic = true;
  lastContact = 0;
  /** Set while the worker wants to know when the event backlog is empty again (after an outage). */
  drainWatch = false;
  falseOfflines = 0;
  readonly linkClass: string;

  constructor(readonly id: AgentIdentity, readonly link: AgentLink, private readonly cfg: AgentConfig, private readonly hooks: AgentHooks) {
    this.linkClass = link.cls.name;
    this.heartbeatSeconds = cfg.protocol === "1.0" ? 60 : 300;
    this.gzipState = cfg.protocol === "1.0" || cfg.gzip === "off" ? "no" : cfg.gzip === "on" ? "yes" : "unknown";
    const day = 86_400_000 / cfg.timeCompression;
    this.nextDrivesAt = Date.now() + Math.random() * day;
    const offer = cfg.httpOffer === "auto" ? (cfg.protocol === "1.1" ? "h2" : "h1") : cfg.httpOffer;
    this.transport = new AgentTransport({ host: cfg.host, port: cfg.port, servername: cfg.servername, ca: cfg.ca, cert: id.certPem, key: id.keyPem, link, offer,
      idleTimeoutMs: cfg.protocol === "1.0" ? 60_000 : 20_000, lifetimeMs: cfg.protocol === "1.0" ? 600_000 : 86_400_000, keepaliveSec: cfg.keepaliveSec,
      onHandshake: (reused, ms, p) => hooks.handshake(this, reused, ms, p), onBytes: (d, n) => hooks.bytes(this, d, n) });
  }

  get queued(): number { return this.priority.length + this.normal.length; }
  get pendingResults(): number { return this.outbox.length; }
  get pendingResultIds(): string[] { return this.outbox.map(o => String(o.result["commandId"]).toLowerCase()); }
  private localNow(): number { return Date.now() + this.cfg.clockOffsetMs; }
  private iso(t = this.localNow()): string { return new Date(t).toISOString(); }
  private v11(): boolean { return this.cfg.protocol === "1.1"; }

  async run(startDelayMs: number): Promise<void> {
    await sleep(startDelayMs);
    if (this.stopped) return;
    const loops = [this.heartbeatLoop(), this.pollLoop(), this.eventLoop(), this.monitorLoop()];
    if (this.v11()) loops.push(this.outboxLoop());
    await Promise.all(loops);
  }

  stop(): void {
    this.stopped = true;
    this.outboxSignal?.();
    this.conn.ok(); // release waiters so the loops can end
    this.transport.stop();
  }

  // ---- Requests --------------------------------------------------------------------------------

  private async send(kind: Kind, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, gzip = false): Promise<HttpResponse | NetError> {
    let payload: Buffer | undefined;
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "MashuraCabinetAgent/1 (load)" };
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers["content-type"] = "application/json";
      if (gzip) { payload = gzipSync(payload); headers["content-encoding"] = "gzip"; }
    }
    if (this.v11()) headers["accept-encoding"] = "gzip";
    const t = performance.now();
    try {
      const r = await this.transport.request(method, path, headers, payload, timeoutMs);
      const ms = performance.now() - t;
      let held = false;
      if (r.status >= 200 && r.status < 300) {
        const st = r.headers["date"];
        // serverTime from the body is preferred (the agent uses it for skew); the Date header is the fallback.
        try { const j = JSON.parse(r.body.toString()) as { serverTime?: string; commands?: unknown[] }; const s = Date.parse(j.serverTime ?? st ?? "");
          if (Number.isFinite(s)) this.lastServer = { server: s, local: this.localNow() };
          held = kind === "poll" && Array.isArray(j.commands) && j.commands.length === 0; } catch { /* checked by the caller */ }
      }
      this.hooks.request(this, kind, ms, String(r.status), { held, bytes: payload?.length ?? 0 });
      return r;
    } catch (e) {
      const err = e instanceof NetError ? e : new NetError("ERR", (e as Error).message);
      // Connections torn down because the run ended are not failures.
      if (err.code !== "ESTOPPED" && !this.stopped) this.hooks.request(this, kind, performance.now() - t, `net:${err.code}`);
      return err;
    }
  }

  private contact(): void {
    const now = Date.now();
    this.hooks.contact(this, now);
    this.lastContact = now;
  }

  /** A network failure: 1.1 marks the shared state offline and returns the wait; 1.0 loops use their own backoff. */
  private netFailed(): number { return this.conn.failed(); }

  /** 503 / 429: wait at least Retry-After (1.1); 1.0 has no idea of it and backs off as for any failure. */
  private refused(r: HttpResponse): void {
    const ms = retryAfterMs(r.headers["retry-after"]);
    this.hooks.count(`refused.${r.status}${ms === null ? "" : ".retryAfter"}`);
    if (this.v11()) this.conn.defer(ms ?? 5_000 + Math.random() * 10_000);
  }

  // ---- Long poll and commands ------------------------------------------------------------------

  private async pollLoop(): Promise<void> {
    const backoff = new LegacyBackoff();
    while (!this.stopped) {
      if (this.v11()) await this.conn.gate(() => this.stopped);
      if (this.stopped) return;
      const sent = this.v11() ? this.acks.slice(0, 50) : [];
      const path = sent.length ? `/agent/v1/commands?ack=${sent.join(",")}` : "/agent/v1/commands";
      const r = await this.send("poll", "GET", path, undefined, this.v11() ? this.pollSeconds * 1000 + 20_000 : 60_000);
      if (this.stopped) return;
      if (r instanceof NetError) {
        if (this.v11()) this.netFailed(); else await sleep(backoff.next());
        continue;
      }
      if (r.status === 503 || r.status === 429) { this.refused(r); if (!this.v11()) await sleep(backoff.next()); continue; }
      if (r.status !== 200) { this.hooks.count(`poll.status.${r.status}`); if (this.v11()) this.netFailed(); else await sleep(backoff.next()); continue; }
      let body: { commands?: unknown; pollSeconds?: unknown; reconnectAfterMs?: unknown };
      try { body = JSON.parse(r.body.toString()) as typeof body; } catch { this.hooks.count("poll.badJson"); continue; }
      if (!Array.isArray(body.commands)) { this.hooks.count("poll.badShape"); continue; }
      backoff.reset();
      if (this.v11()) {
        this.conn.ok();
        this.acks = this.acks.filter(a => !sent.includes(a));
        const ps = clamp(body.pollSeconds, 15, 110);
        if (ps !== null) this.pollSeconds = ps;
        const ra = clamp(body.reconnectAfterMs, 0, 600_000);
        if (ra !== null) { this.hooks.count("poll.reconnectAfterMs"); this.conn.defer(ra); }
      }
      // Presence: a 1.1 server counts a poll as contact; a 1.0 server only a heartbeat.
      if (this.v11()) this.contact();
      for (const c of body.commands) {
        if (this.v11()) { void this.handleCommand(c); }
        else await this.handleCommand(c); // the 1.0 loop runs each command before it polls again
      }
    }
  }

  private async handleCommand(raw: unknown): Promise<void> {
    const c = raw as { commandId?: unknown; cabinetId?: unknown; operation?: unknown; expiresAt?: unknown };
    if (typeof c !== "object" || c === null || typeof c.commandId !== "string" || !UUID.test(c.commandId)) { this.hooks.count("command.malformed"); return; }
    const id = c.commandId.toLowerCase();
    const now = Date.now();
    const op = typeof c.operation === "string" ? c.operation : "?";
    if (this.v11()) this.acks.push(c.commandId);
    const prior = this.seen.get(id);
    this.hooks.received(this, id, op, now, prior !== undefined);
    if (prior) {
      // A lease re-offer: answered from the replay store (its result goes out again), never run twice.
      if (prior.result && this.v11() && !this.outbox.some(o => o.result["commandId"] === c.commandId)) this.enqueueResult(prior.result as Record<string, unknown>);
      return;
    }
    this.seen.set(id, { at: now, result: null });
    if (this.seen.size > 2000) for (const [k, v] of this.seen) if (now - v.at > 3_600_000) this.seen.delete(k);
    const started = this.iso();
    let result: Record<string, unknown>;
    if (c.cabinetId !== this.id.cabinetId) {
      result = { commandId: c.commandId, status: "rejected", startedAt: started, finishedAt: started, error: { code: "wrong_cabinet", message: "not this cabinet" } };
    } else if (typeof c.expiresAt !== "string" || !(Date.parse(c.expiresAt) > this.localNow())) {
      result = { commandId: c.commandId, status: "rejected", startedAt: started, finishedAt: started, error: { code: "expired", message: "arrived after expiry" } };
    } else {
      await sleep(this.runtimeMs(op));
      if (this.stopped && !this.v11()) return;
      result = { commandId: c.commandId, status: "succeeded", startedAt: started, finishedAt: this.iso(), output: this.hooks.outputs[op] ?? this.hooks.outputs["system.info"] };
    }
    this.seen.get(id)!.result = result;
    if (this.v11()) this.enqueueResult(result);
    else await this.postResultLegacy(result);
  }

  private runtimeMs(op: string): number {
    if (op === "eventlog.query") return 2_000 + Math.random() * 18_000;
    if (op === "system.checkHealth") return this.cfg.installMinutes * 60_000 * (0.8 + Math.random() * 0.4);
    if (op === "system.info") return 200 + Math.random() * 1_200;
    return 500 + Math.random() * 1_500;
  }

  // ---- Results ---------------------------------------------------------------------------------

  private enqueueResult(result: Record<string, unknown>): void {
    this.outbox.push({ result, attempts: 0 });
    this.outboxSignal?.();
  }

  /** 1.1: the outbox is posted from its own loop until the server accepts each result (409 = already stored). */
  private async outboxLoop(): Promise<void> {
    while (!this.stopped) {
      const item = this.outbox[0];
      if (!item) { await new Promise<void>(r => { this.outboxSignal = r; setTimeout(r, 5_000); }); this.outboxSignal = null; continue; }
      await this.conn.gate(() => this.stopped);
      if (!this.conn.online) await this.conn.waitOnline();
      if (this.stopped) return;
      item.attempts++;
      const r = await this.send("result", "POST", "/agent/v1/results", item.result, 60_000);
      const id = String(item.result["commandId"]).toLowerCase();
      if (r instanceof NetError) { this.netFailed(); continue; }
      if (r.status === 200) { this.outbox.shift(); this.hooks.resultDone(this, id, "accepted"); this.conn.ok(); continue; }
      if (r.status === 409) { this.outbox.shift(); this.hooks.resultDone(this, id, "already"); continue; }
      if (r.status === 503 || r.status === 429) { this.refused(r); continue; }
      if (r.status === 400 || r.status === 404) { this.outbox.shift(); this.hooks.resultDone(this, id, "refused"); continue; }
      this.netFailed(); // 5xx: try again later
    }
  }

  /** 1.0: PostResultAsync, 8 attempts with backoff, then the result is given up. */
  private async postResultLegacy(result: Record<string, unknown>): Promise<void> {
    const backoff = new LegacyBackoff();
    const id = String(result["commandId"]).toLowerCase();
    for (let attempt = 0; attempt < 8 && !this.stopped; attempt++) {
      const r = await this.send("result", "POST", "/agent/v1/results", result, 60_000);
      if (!(r instanceof NetError)) {
        if (r.status === 200) { this.hooks.resultDone(this, id, "accepted"); return; }
        if (r.status === 409) { this.hooks.resultDone(this, id, "already"); return; }
        if (r.status === 400 || r.status === 404) { this.hooks.resultDone(this, id, "refused"); return; }
      }
      await sleep(backoff.next());
    }
    if (!this.stopped) this.hooks.resultDone(this, id, "abandoned");
  }

  // ---- Heartbeat -------------------------------------------------------------------------------

  private heartbeatBody(): Record<string, unknown> {
    const now = Date.now();
    const skew = this.lastServer ? Math.max(-86_400, Math.min(86_400, Math.round((this.lastServer.local - this.lastServer.server) / 100) / 10)) : undefined;
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

  private async heartbeatLoop(): Promise<void> {
    const backoff = new LegacyBackoff();
    while (!this.stopped) {
      if (this.v11()) { await this.conn.gate(() => this.stopped); if (this.stopped) return; }
      const body = this.heartbeatBody();
      const r = await this.send("heartbeat", "POST", "/agent/v1/heartbeat", body, 60_000);
      if (this.stopped) return;
      if (r instanceof NetError || r.status >= 500 || r.status === 429) {
        if (!(r instanceof NetError) && (r.status === 503 || r.status === 429)) this.refused(r);
        if (this.v11()) {
          if (r instanceof NetError) this.netFailed();
          await this.conn.waitOnline(); // the poll loop probes; send a heartbeat as soon as the server is back
          await this.conn.gate(() => this.stopped);
        } else await sleep(backoff.next());
        continue;
      }
      if (r.status !== 200) { this.hooks.count(`heartbeat.status.${r.status}`); await sleep(backoff.next()); continue; }
      backoff.reset();
      if (body["health"]) this.lastHealthAt = Date.now();
      this.contact();
      if (this.v11()) {
        this.conn.ok();
        try {
          const j = JSON.parse(r.body.toString()) as { intervals?: { heartbeatSeconds?: unknown; pollSeconds?: unknown; eventsPaceMs?: unknown } };
          const hb = clamp(j.intervals?.heartbeatSeconds, 60, 900); if (hb !== null) this.heartbeatSeconds = hb;
          const ps = clamp(j.intervals?.pollSeconds, 15, 110); if (ps !== null) this.pollSeconds = ps;
          const ep = clamp(j.intervals?.eventsPaceMs, 0, 60_000); if (ep !== null) this.eventsPace = ep;
          if (j.intervals) this.hooks.count("heartbeat.intervals");
        } catch { this.hooks.count("heartbeat.badJson"); }
      }
      await this.sleepOrStop(this.heartbeatSeconds * 1000);
    }
  }

  private async sleepOrStop(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!this.stopped && Date.now() < end) await sleep(Math.min(5_000, end - Date.now()));
  }

  // ---- Events ----------------------------------------------------------------------------------

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
    const n = Math.min(this.cfg.eventQueueCap, Math.round(this.cfg.eventsPerHour * hours));
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
      ev = { eventId, kind: "firewall_changed", occurredAt, severityHint: "minor", detail: { message: "Rule MashuraDiag Sync TCP 1433 created." } };
    } else if (u < 0.98) {
      ev = { eventId, kind: "smart_warning", occurredAt, severityHint: "major", detail: { message: "Drive predicts failure.", fields: { model: "NVMe 256GB" } } };
    } else {
      ev = { eventId, kind: "agent_status", occurredAt, severityHint: "minor", detail: { message: "The agent restarted after an update.", fields: { reason: "restart" } } };
    }
    const json = JSON.stringify(ev);
    return { id: eventId, json, bytes: Buffer.byteLength(json), failures: 0 };
  }

  private enqueue(e: QueuedEvent): void {
    const isPriority = e.json.includes('"kind":"security"') || e.json.includes('"kind":"agent_status"');
    if (isPriority && this.v11()) { this.priority.push(e); return; }
    this.normal.push(e);
    if (this.normal.length > this.cfg.eventQueueCap) { this.normal.shift(); this.hooks.count("events.droppedQueueFull"); }
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

  private async eventLoop(): Promise<void> {
    const backoff = new LegacyBackoff();
    while (!this.stopped) {
      if (this.queued === 0) {
        if (this.drainWatch) { this.drainWatch = false; this.hooks.drained(this, Date.now()); }
        await this.sleepOrStop(15_000);
        continue;
      }
      if (this.v11()) {
        await this.conn.gate(() => this.stopped);
        if (!this.conn.online) await this.conn.waitOnline();
        if (this.stopped) return;
      }
      const batch = this.v11() ? takeBatch(this.priority, this.normal, this.batchMax, 256 * 1024) : this.normal.slice(0, 100);
      const gzip = this.gzipState !== "no";
      const r = await this.send("events", "POST", "/agent/v1/events", { events: batch.map(e => JSON.parse(e.json) as unknown) }, 60_000, gzip);
      if (this.stopped) return;
      if (r instanceof NetError) {
        if (this.v11()) this.netFailed(); else await sleep(backoff.next());
        continue;
      }
      if (gzip && this.gzipState === "unknown" && (r.status === 400 || r.status === 415)) {
        // The server did not take a compressed body: send plain from now on.
        this.gzipState = "no";
        this.hooks.count("events.gzipNotAccepted");
        continue;
      }
      if (r.status === 200) {
        if (gzip) { if (this.gzipState === "unknown") this.hooks.count("events.gzipAccepted"); this.gzipState = "yes"; }
        this.remove(batch);
        this.hooks.count("events.sent", batch.length);
        backoff.reset();
        if (this.v11()) this.conn.ok();
        if (this.queued > 0) {
          const pace = this.v11() ? (this.eventsPace ?? this.cfg.eventsPaceMs) : 0;
          if (pace > 0) await sleep(pace);
        }
        continue;
      }
      if (r.status === 429 || r.status === 503) {
        this.refused(r);
        if (!this.v11()) await sleep(backoff.next());
        continue;
      }
      if (r.status === 413 && this.v11()) { this.batchMax = Math.max(1, Math.floor(batch.length / 2)); this.hooks.count("events.413"); continue; }
      if (r.status === 400) {
        if (!this.v11()) { this.remove(batch); this.hooks.count("events.droppedMalformed", batch.length); continue; }
        // 1.1: a batch that keeps failing sets its first event aside, so one bad event cannot stall the queue.
        const first = batch[0]!;
        if (++first.failures >= 3) { this.remove([first]); this.hooks.count("events.setAside"); }
        else if (batch.length > 1) this.batchMax = Math.max(1, Math.floor(batch.length / 2));
        continue;
      }
      if (this.v11()) this.netFailed(); else await sleep(backoff.next());
    }
  }
}

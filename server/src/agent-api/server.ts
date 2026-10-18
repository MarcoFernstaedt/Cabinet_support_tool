// The agent API (docs/spec/03-protocol.md): its own listener, mutual TLS
// terminated by Node itself so the client certificate is checked directly.
// Every body is validated against its contract before anything reads it.
//
// Protocol 1.1 ("Protocol 1.1" in 03-protocol.md): HTTP/2 (and HTTP/1.1 keep-alive) on one long-lived connection per agent, TCP
// keepalives, TLS session tickets, leased command delivery, presence from the long poll, server-directed pacing, admission control
// and load shedding with a randomised Retry-After, and gzip-compressed event batches.
import type { Socket } from "node:net";
import type { TLSSocket, Server as TlsServer } from "node:tls";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { randomBytes, randomInt } from "node:crypto";
import { Transform, pipeline, type Readable, type TransformCallback } from "node:stream";
import { createGunzip } from "node:zlib";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ContractError, envelopes } from "../contracts.js";
import { audit, errorInfo, isBusy, transaction, type Pool } from "../db/db.js";
import { CsrError, type IssuingKey } from "../pki/x509.js";
import { authenticate, recordHeartbeat, renewCertificate, type AuthenticatedCabinet } from "../services/cabinets.js";
import { storeResult, takeLeasedCommands, LEASE_SECONDS, MAX_COMMANDS_PER_POLL } from "../services/commands.js";
import { enrollmentStatus, submitEnrollment } from "../services/enrollment.js";
import { Refused } from "../services/errors.js";
import { storeEvents } from "../services/events.js";
import { resolveOfflineFor } from "../services/alerts.js";
import { evaluateTime } from "../services/time.js";
import { evaluateDrift } from "../services/firewall-policy.js";
import type { CommandNotifier } from "./notifier.js";
import { createReadStream } from "node:fs";
import { downloadablePath, type PackageStore } from "../services/packages.js";
import { raiseSecurityAlert } from "../services/security.js";
import { releaseForAgent, releasePackageForAgent, type ReleaseStore } from "../services/releases.js";
import { anyRolloutRunning, offerFor, recordUpgradeStatus } from "../services/rollouts.js";
import { PacingCache } from "../services/settings.js";
import { Presence } from "./presence.js";
import { revocationEpoch } from "./revocations.js";

/** Admission control and load shedding (all per server process). */
export interface Admission {
  /** New connections (TLS handshakes) admitted per second, and the burst above that rate. */
  newConnectionsPerSecond: number; newConnectionsBurst: number;
  /** Agent requests admitted per second, and the burst. */
  requestsPerSecond: number; requestsBurst: number;
  /** Shed load when more requests than this wait for a database connection... */
  maxPendingAcquires: number;
  /** ...or the event loop lags by more than this. */
  maxEventLoopLagMs: number;
  /** Retry-After range for shed requests, in seconds. */
  retryAfterSeconds: [number, number];
  /** Tests force the overloaded state. */
  overloaded?: () => boolean;
}

export const DEFAULT_ADMISSION: Admission = {
  newConnectionsPerSecond: 100, newConnectionsBurst: 300, requestsPerSecond: 2_000, requestsBurst: 4_000,
  maxPendingAcquires: 20, maxEventLoopLagMs: 250, retryAfterSeconds: [30, 90],
};

export interface AgentApiOptions {
  pool: Pool;
  issuingKey: IssuingKey;
  notifier: CommandNotifier;
  tls: { certPem: string; keyPem: string };
  /** How long a poll is held. Fixed in tests; otherwise the platform's pacing setting (default 25 s). */
  longPollMs?: number;
  /** The software library's store, for package downloads; omitted where no packages exist (some tests). */
  packages?: PackageStore;
  /** The update store for signed agent releases; omitted where no releases exist (some tests). */
  releases?: ReleaseStore;
  /** Enrollment submissions allowed per source address per hour. */
  enrollPerHour?: number;
  /** How many events one cabinet may send in an hour before it is asked to slow down (its own queue holds the rest). */
  eventsPerHour?: number;
  /** Where contact from polls is kept until the minute's batched write; made (and flushed every minute) here when not given. */
  presence?: Presence;
  /** How long a delivered command stays leased to a poll (shorter in tests). */
  leaseSeconds?: number;
  /** HTTP/2 with HTTP/1.1 fallback on the same port (default true). */
  http2?: boolean;
  admission?: Partial<Admission>;
  /** How long an accepted certificate is remembered for its connection before it is checked again. */
  authCacheMs?: number;
  /** The TLS session-ticket key for a UTC day (48 bytes). Given when several processes serve the agent port, so a session resumes in
   *  any of them; otherwise each process uses its own random key, changed daily. */
  ticketKey?: (day: number) => Buffer;
  logger?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const serverTime = (): string => new Date().toISOString();
/** Request bodies are capped at 1 MB (docs/spec/03-protocol.md), after decompression for gzip event batches. */
export const BODY_LIMIT = 1024 * 1024;

declare module "fastify" {
  interface FastifyRequest { cabinet?: AuthenticatedCabinet }
}

/** A token bucket: rate tokens a second, up to burst. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly rate: number, private readonly burst: number) { this.tokens = burst; }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** The acknowledgement list of a poll: ?ack=<id>,<id> with at most MAX_COMMANDS_PER_POLL command IDs; anything else is refused. */
export function parseAcks(query: unknown): string[] {
  const q = (query ?? {}) as Record<string, unknown>;
  const keys = Object.keys(q);
  if (keys.some(k => k !== "ack")) throw new Refused("invalid_request", 400, "unknown query parameter");
  if (q.ack === undefined) return [];
  if (typeof q.ack !== "string" || q.ack.length === 0 || q.ack.length > MAX_COMMANDS_PER_POLL * 37) throw new Refused("invalid_request", 400, "ack must be a list of command IDs");
  const ids = q.ack.split(",");
  if (ids.length > MAX_COMMANDS_PER_POLL || !ids.every(id => UUID.test(id))) throw new Refused("invalid_request", 400, "ack must be a list of command IDs");
  return [...new Set(ids.map(id => id.toLowerCase()))];
}

/** Caps a decompressed body: past max bytes the stream fails with 413 and decompression stops. */
class Capped extends Transform {
  private received = 0;
  /** The bytes that arrived on the wire, which Fastify compares with Content-Length. */
  receivedEncodedLength = 0;
  constructor(private readonly max: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.received += chunk.length;
    if (this.received > this.max) done(Object.assign(new Error("the decompressed body is larger than allowed"), { statusCode: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE" }));
    else done(null, chunk);
  }
}

/** The HTTP/2 session or the HTTP/1.1 socket a request came on: what an accepted certificate is remembered for. */
function connectionOf(request: FastifyRequest): object {
  return (request.raw as unknown as { stream?: { session?: object } }).stream?.session ?? request.raw.socket;
}
/** The TLS socket under a request, for HTTP/2 streams (through their session) as for HTTP/1.1. */
function tlsSocketOf(request: FastifyRequest): TLSSocket {
  return ((request.raw as unknown as { stream?: { session?: { socket?: TLSSocket } } }).stream?.session?.socket ?? request.raw.socket) as TLSSocket;
}
const isHttp2 = (request: FastifyRequest): boolean => request.raw.httpVersionMajor === 2;

export async function buildAgentApi(o: AgentApiOptions): Promise<FastifyInstance> {
  const http2 = o.http2 ?? true;
  const tlsOptions = {
    key: o.tls.keyPem, cert: o.tls.certPem, ca: o.issuingKey.certificatePem, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.2" as const,
    // TLS session tickets: a reconnecting agent resumes its session (the certificate it proved stays bound to it) instead of a full
    // handshake. The ticket keys are this process's own and are replaced daily.
    sessionTimeout: 24 * 3600,
    ...(http2 ? { allowHTTP1: true } : {}),
  };
  const app = Fastify({
    ...(http2 ? { http2: true as const, http2SessionTimeout: 130_000 } : {}),
    https: tlsOptions,
    bodyLimit: BODY_LIMIT,
    // An agent keeps its connection between polls; idle longer than the longest poll (110 s) plus a margin, it is closed.
    keepAliveTimeout: 130_000,
    logger: o.logger === false ? false : { level: "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    // 10,000 cabinets make hundreds of requests a second; each request is not logged (refusals and errors are, and
    // everything that matters is in the audit log).
    disableRequestLogging: true,
    // Requests during shutdown are answered by the admission hook below, with a spread-out Retry-After.
    return503OnClosing: false,
    forceCloseConnections: false,
  } as Parameters<typeof Fastify>[0]) as unknown as FastifyInstance;
  const enrollPerHour = o.enrollPerHour ?? 10;
  // The ingest quota (docs/platform/data-classification.md): per cabinet, per clock hour, kept in memory. Over it, a batch
  // is refused with 429 and the agent keeps the events in its own bounded queue and sends them later.
  const eventsPerHour = o.eventsPerHour ?? 3000;
  const eventCounts = new Map<string, { hour: number; n: number }>();
  const enrollAttempts = new Map<string, number[]>();
  const refusedLogged = new Map<string, number>();
  const admission: Admission = { ...DEFAULT_ADMISSION, ...o.admission };
  const leaseSeconds = o.leaseSeconds ?? LEASE_SECONDS;
  const authCacheMs = o.authCacheMs ?? 60_000;
  const pacing = new PacingCache(o.pool);
  const ownPresence = !o.presence;
  const presence = o.presence ?? new Presence(o.pool, message => app.log.error(message));
  if (ownPresence) presence.start();

  // ---- Connections -----------------------------------------------------------------------------------------------------
  const server = app.server as unknown as TlsServer;
  const http1Sockets = new Set<TLSSocket>();
  // TCP keepalives every 20 s keep NAT entries alive and find dead peers; a TLS 1.2 renegotiation could swap the certificate on a
  // connection whose acceptance is remembered, so it is refused.
  server.on("connection", (socket: Socket) => socket.setKeepAlive(true, 20_000));
  server.on("secureConnection", (socket: TLSSocket) => {
    socket.disableRenegotiation();
    if (socket.alpnProtocol !== "h2") { http1Sockets.add(socket); socket.once("close", () => http1Sockets.delete(socket)); }
  });
  const http2Sessions = new Set<{ close(): void; once(event: "close", f: () => void): void }>();
  server.on("session", (session: { close(): void; once(event: "close", f: () => void): void }) => {
    http2Sessions.add(session);
    session.once("close", () => http2Sessions.delete(session));
  });
  const today = (): number => Math.floor(Date.now() / 86_400_000);
  let ticketDay = today();
  if (o.ticketKey) server.setTicketKeys(o.ticketKey(ticketDay));
  const ticketTimer = o.ticketKey
    ? setInterval(() => { if (today() !== ticketDay) { ticketDay = today(); server.setTicketKeys(o.ticketKey!(ticketDay)); } }, 60_000)
    : setInterval(() => server.setTicketKeys(randomBytes(48)), 24 * 3600_000);
  ticketTimer.unref();

  // ---- Load: the database pool's queue and the event loop's lag ------------------------------------------------------------
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  // Lag counts only when it lasts: three seconds in a row over the limit. One garbage-collection pause must not turn away a minute of
  // agents (a shed agent stays away 30 to 90 s), while a server that is really behind still sheds within seconds.
  let lagSeconds = 0;
  const lagTimer = setInterval(() => { lagSeconds = lag.percentile(99) / 1e6 > admission.maxEventLoopLagMs ? lagSeconds + 1 : 0; lag.reset(); }, 1_000);
  lagTimer.unref();
  const overloaded = (): boolean => admission.overloaded?.() ?? (o.pool.pending > admission.maxPendingAcquires || lagSeconds >= 3);
  const connectionTokens = new TokenBucket(admission.newConnectionsPerSecond, admission.newConnectionsBurst);
  const requestTokens = new TokenBucket(admission.requestsPerSecond, admission.requestsBurst);
  const admitted = new WeakSet<object>();
  const retryAfter = (): number => randomInt(admission.retryAfterSeconds[0], admission.retryAfterSeconds[1] + 1);

  // ---- Shutdown: every held poll is ended with a spread-out reconnectAfterMs -----------------------------------------------------
  let shuttingDown = false;
  const held = new Set<{ abort: AbortController; done: Promise<void> }>();
  let inFlight = 0;
  const reconnectSpread = (): number => randomInt(0, 60_001);

  // Only JSON request bodies exist on this API.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, JSON.parse(body as string)); }
    catch { done(new Refused("invalid_json", 400, "body is not JSON"), undefined); }
  });

  /** A refusal for load: 503 with a randomised Retry-After; a long poll instead gets an empty answer telling it when to come back. */
  const shed = (request: FastifyRequest, reply: FastifyReply, opts: { seconds: number; closeConnection?: boolean; pollAnswer?: boolean; pollMs?: number }): FastifyReply => {
    if (opts.closeConnection) {
      if (isHttp2(request)) reply.raw.once("finish", () => (request.raw as unknown as { stream?: { session?: { close(): void } } }).stream?.session?.close());
      else reply.header("connection", "close");
    }
    const isPoll = request.method === "GET" && request.url.split("?")[0] === "/agent/v1/commands";
    if (isPoll && opts.pollAnswer !== false)
      return reply.code(200).send({ serverTime: serverTime(), commands: [], reconnectAfterMs: opts.pollMs ?? opts.seconds * 1000 });
    return reply.code(503).header("retry-after", String(opts.seconds)).send({ error: "busy" });
  };

  // Requests in progress, so shutdown can let them finish before it closes idle connections.
  app.addHook("onRequest", async (_request, reply) => {
    inFlight++;
    reply.raw.once("close", () => { inFlight--; });
  });
  // Admission, before anything touches the database: shutdown, new-connection and request rates, and load.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (shuttingDown) {
      const ms = reconnectSpread();
      return shed(request, reply, { seconds: Math.ceil(ms / 1000), closeConnection: true });
    }
    const connection = connectionOf(request);
    if (!admitted.has(connection)) {
      if (!connectionTokens.take()) return shed(request, reply, { seconds: retryAfter(), closeConnection: true, pollAnswer: false });
      admitted.add(connection);
    }
    if (!requestTokens.take()) return shed(request, reply, { seconds: retryAfter(), pollAnswer: false });
    // A long poll turned away for load comes back within seconds: it costs the database almost nothing (one seek when nothing waits),
    // and sending it away for a minute would leave its cabinet unable to receive a command for that long.
    if (overloaded()) return shed(request, reply, { seconds: retryAfter(), pollMs: randomInt(2_000, 10_001) });
  });

  app.addHook("preClose", async () => {
    shuttingDown = true;
    for (const h of held) h.abort.abort();
    // The held polls write their answers (with reconnectAfterMs), other requests finish, then idle HTTP/1.1 connections are closed;
    // HTTP/2 sessions are told to go away (GOAWAY: no new streams, the open ones finish).
    await Promise.race([Promise.all([...held].map(h => h.done)), new Promise(r => setTimeout(r, 2_000))]);
    const until = Date.now() + 5_000;
    while (inFlight > 0 && Date.now() < until) await new Promise(r => setTimeout(r, 25));
    for (const s of http1Sockets) s.destroy();
    for (const s of http2Sessions) s.close();
  });
  app.addHook("onClose", async () => {
    clearInterval(ticketTimer);
    clearInterval(lagTimer);
    lag.disable();
    if (ownPresence) await presence.stop();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Refused) return reply.code(error.status).send({ error: error.code });
    if (error instanceof ContractError) return reply.code(400).send({ error: "invalid_request", issues: error.issues });
    if (error instanceof CsrError) return reply.code(400).send({ error: "invalid_request" });
    // The database could not answer in time: the agent comes back later, at a random moment.
    if (isBusy(error)) return reply.code(503).header("retry-after", String(retryAfter())).send({ error: "busy" });
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 413) return reply.code(413).send({ error: "too_large" });
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: "invalid_request" });
    request.log.error({ err: errorInfo(error) }, "request failed");
    return reply.code(500).send({ error: "server_error" });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));

  /**
   * Every route except enrollment and health needs a certificate this server issued to an active cabinet. An accepted certificate is
   * remembered for its connection (an HTTP/2 session or an HTTP/1.1 socket) and checked against the database again after authCacheMs,
   * at once after any revocation (revocations.ts), and never past the certificate's own expiry.
   */
  const accepted = new WeakMap<object, { cabinet: AuthenticatedCabinet; subject: string; notAfter: number; checkedAt: number; epoch: number }>();
  const requireCabinet = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const socket = tlsSocketOf(request);
    // The certificate the caller presented, whether or not it chains to our CA (empty when none was presented).
    const peer = socket.getPeerCertificate();
    const serial = /^[0-9A-Fa-f]{2,64}$/.test(peer?.serialNumber ?? "") ? peer.serialNumber.toUpperCase() : "";
    const subject = typeof peer?.subject?.CN === "string" ? peer.subject.CN : "";
    const connection = connectionOf(request);
    const now = Date.now();
    const known = accepted.get(connection);
    if (known && socket.authorized && serial && known.cabinet.serial === serial && known.subject === subject && known.epoch === revocationEpoch()
      && now - known.checkedAt < authCacheMs && now < known.notAfter) {
      request.cabinet = known.cabinet;
      return;
    }
    const epoch = revocationEpoch();
    const found = socket.authorized && serial ? await authenticate(o.pool, serial, subject) : null;
    if (!found) {
      accepted.delete(connection);
      await noteRefusal(request, socket.authorized, serial, subject);
      return reply.code(401).send({ error: "certificate_refused" });
    }
    const cabinet = { id: found.id, serial: found.serial };
    accepted.set(connection, { cabinet, subject, notAfter: found.notAfter.getTime(), checkedAt: now, epoch });
    request.cabinet = cabinet;
  };

  /** Why a presented certificate was not accepted: not ours, revoked, expired, for a removed cabinet, naming another cabinet, or not on record. */
  const refusalReason = async (authorized: boolean, serial: string, subject: string): Promise<{ reason: string; cabinetId: string | null }> => {
    if (!authorized) return { reason: "unknown", cabinetId: null };
    const row = (await o.pool.query<{ cabinet_id: string; revoked: number; expired: number; active: number }>(
      `SELECT c.cabinet_id, CASE WHEN c.revoked_at IS NOT NULL THEN 1 ELSE 0 END AS revoked, CASE WHEN c.not_after <= SYSUTCDATETIME() THEN 1 ELSE 0 END AS expired,
              CASE WHEN k.status = 'active' THEN 1 ELSE 0 END AS active
         FROM cabinet_certificates c JOIN cabinets k ON k.id = c.cabinet_id WHERE c.serial = $1`, [serial])).rows[0];
    if (!row) return { reason: "unknown", cabinetId: null };
    const reason = row.revoked === 1 ? "revoked" : row.expired === 1 ? "expired" : row.active !== 1 ? "removed" : row.cabinet_id !== subject ? "mismatched" : "unknown";
    return { reason, cabinetId: row.cabinet_id };
  };

  /**
   * Logs a refused connection. A presented certificate that is not accepted (revoked, or unknown to this platform) is
   * also audited and raises a security alert, at most hourly per serial and every 10 s per reason, so someone trying
   * certificates from the internet cannot flood the database. A caller with no certificate at all is only logged.
   */
  const noteRefusal = async (request: FastifyRequest, authorized: boolean, serial: string, subject: string): Promise<void> => {
    request.log.warn({ authorized, serial, remote: request.ip }, "agent connection refused");
    if (!serial) return;
    const now = Date.now();
    if (now - (refusedLogged.get(serial) ?? 0) < 3_600_000) return;
    if (refusedLogged.size > 10_000) refusedLogged.clear();
    refusedLogged.set(serial, now);
    try {
      const { reason, cabinetId } = await refusalReason(authorized, serial, subject);
      if (now - (refusedLogged.get(`reason|${reason}`) ?? 0) < 10_000) return;
      refusedLogged.set(`reason|${reason}`, now);
      await transaction(o.pool, async c => {
        await audit(c, { actorKind: "agent", actorId: serial, action: "agent.connection_refused", outcome: "refused",
          details: { certificateSerial: serial, reason, source: request.ip } });
        await raiseSecurityAlert(c, { kind: "certificate", signature: `certificate|${reason}`, cabinetId: reason === "unknown" ? null : cabinetId,
          title: reason === "revoked" ? "A cabinet connected with a revoked certificate"
            : reason === "unknown" ? "A connection presented a certificate this platform did not issue or has no record of"
            : `A cabinet connected with a certificate that is not accepted (${reason})`,
          detail: { certificateSerial: serial, reason, source: request.ip, cabinetId } });
      });
    } catch { /* a refused connection must never fail the refusal */ }
  };

  /** How long a poll is held now, and what the answers tell the agent about it (the contract allows 15 to 110 s). */
  const holdMs = async (): Promise<number> => o.longPollMs ?? (await pacing.get()).pollSeconds * 1000;
  const reportedPollSeconds = (ms: number): number => Math.min(110, Math.max(15, Math.round(ms / 1000)));

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/agent/v1/enroll", async (request, reply) => {
    const now = Date.now();
    const recent = (enrollAttempts.get(request.ip) ?? []).filter(t => now - t < 3_600_000);
    if (recent.length >= enrollPerHour) return reply.code(429).send({ error: "rate_limited" });
    recent.push(now);
    enrollAttempts.set(request.ip, recent);
    // Kept bounded: addresses with no attempt in the last hour are dropped once the map grows.
    if (enrollAttempts.size > 10_000)
      for (const [ip, times] of enrollAttempts) if (!times.some(t => now - t < 3_600_000)) enrollAttempts.delete(ip);
    const body = envelopes.enrollRequest.parse(request.body);
    try {
      const requestId = await submitEnrollment(o.pool, body, request.ip);
      return reply.code(202).send(envelopes.enrollResponse.parse({ requestId, status: "pending", serverTime: serverTime() }));
    } catch (e) {
      if (e instanceof Refused && e.code === "enrollment_refused")
        await transaction(o.pool, c => audit(c, { actorKind: "agent", actorId: body.fingerprints.hostname, action: "enrollment.submit", outcome: "refused",
          details: { hostname: body.fingerprints.hostname, source: request.ip, reason: "bootstrap token not accepted" } })).catch(() => undefined);
      throw e;
    }
  });

  app.get<{ Params: { requestId: string } }>("/agent/v1/enroll/:requestId", async (request, reply) => {
    if (!UUID.test(request.params.requestId)) return reply.code(404).send({ error: "not_found" });
    const status = await enrollmentStatus(o.pool, request.params.requestId.toLowerCase());
    if (!status) return reply.code(404).send({ error: "not_found" });
    return envelopes.enrollStatus.parse({ ...status, ...(status.status === "issued" ? { caChain: o.issuingKey.certificatePem } : {}), serverTime: serverTime() });
  });

  app.register(async scoped => {
    // The certificate is checked before the body is even read, so an unknown caller cannot make the server parse or decompress it.
    scoped.addHook("onRequest", requireCabinet);
    // Only event batches may be compressed (gzip); any other encoding is refused rather than parsed as JSON.
    scoped.addHook("onRequest", async (request, reply) => {
      const encoding = String(request.headers["content-encoding"] ?? "identity").trim().toLowerCase();
      if (encoding === "identity") return;
      if (encoding === "gzip" && request.method === "POST" && request.url.split("?")[0] === "/agent/v1/events") return;
      return reply.code(415).send({ error: "unsupported_encoding" });
    });

    scoped.get("/agent/v1/commands", async (request, reply) => {
      const acks = parseAcks(request.query);
      const cabinetId = request.cabinet!.id;
      presence.touch(cabinetId);
      const abort = new AbortController();
      let finished!: () => void;
      const entry = { abort, done: new Promise<void>(r => { finished = r; }) };
      // The response closing before it was written means the agent went away: the wait ends (a command handed to it stays leased).
      reply.raw.once("close", () => { if (!reply.raw.writableFinished) abort.abort(); finished(); });
      reply.raw.once("finish", () => finished());
      held.add(entry);
      try {
        const hold = await holdMs();
        const deadline = Date.now() + hold;
        // The database is checked when the poll arrives, again when a command for this cabinet is announced (or every 5 s while
        // the announcement listener is reconnecting), and when a lease on one of its commands ends (a command handed to a poll
        // whose answer may have been lost is offered again). The wake counter is read before the check, so a command queued in
        // between still ends the wait at once.
        let mark = o.notifier.mark(cabinetId);
        let taken = await takeLeasedCommands(o.pool, cabinetId, acks, leaseSeconds);
        while (taken.commands.length === 0 && Date.now() < deadline && !abort.signal.aborted && !shuttingDown) {
          const before = mark;
          // A lease end is checked a little after it, and never sooner than 250 ms from now (the two clocks may differ slightly).
          const leaseCheck = taken.nextLeaseEnd ? Math.max(taken.nextLeaseEnd.getTime() + 250, Date.now() + 250) : Infinity;
          const until = Math.min(deadline, leaseCheck);
          await o.notifier.wait(cabinetId, o.notifier.listening ? until - Date.now() : Math.min(until - Date.now(), 5_000), abort.signal, before);
          if (abort.signal.aborted || shuttingDown) break;
          mark = o.notifier.mark(cabinetId);
          const leaseDue = Date.now() >= leaseCheck;
          if (mark === before && o.notifier.listening && !leaseDue && Date.now() >= deadline - 5) break; // the poll simply ran out
          taken = await takeLeasedCommands(o.pool, cabinetId, [], leaseSeconds);
        }
        presence.touch(cabinetId);
        return envelopes.commandsResponse.parse({ serverTime: serverTime(), commands: taken.commands, pollSeconds: reportedPollSeconds(hold),
          ...(shuttingDown ? { reconnectAfterMs: reconnectSpread() } : {}) });
      } finally {
        held.delete(entry);
      }
    });

    scoped.post("/agent/v1/results", async request => {
      await storeResult(o.pool, request.cabinet!.id, envelopes.result.parse(request.body));
      return { serverTime: serverTime() };
    });

    scoped.post("/agent/v1/heartbeat", async request => {
      const cabinetId = request.cabinet!.id;
      const heartbeat = envelopes.heartbeat.parse(request.body);
      // One round trip records it (and its load sample) and reads the scanner and watched-services settings the answer carries.
      const { wasOffline, firewallChanged, timeCheck, scannerIds, watched } = await recordHeartbeat(o.pool, cabinetId, heartbeat);
      if (wasOffline) await resolveOfflineFor(o.pool, cabinetId);
      // Compared with the client's firewall policy only when the profiles changed (or were first reported).
      if (firewallChanged) await evaluateDrift(o.pool, { cabinetId });
      // Compared with the site's time zone and the server's clock only when the zone changed or the clock is, or was, off.
      if (timeCheck) await evaluateTime(o.pool, { cabinetId });
      // A running rollout that has reached this cabinet's batch offers it the release (or notes that it already runs it).
      const upgrade = (await anyRolloutRunning(o.pool)) ? await transaction(o.pool, c => offerFor(c, cabinetId, heartbeat.agentVersion)) : null;
      // Server-directed pacing: under load a backlog of events is drained more slowly.
      const p = await pacing.get();
      const eventsPaceMs = overloaded() || o.pool.pending > 0 ? Math.min(60_000, Math.max(p.eventsPaceMs * 4, 10_000)) : p.eventsPaceMs;
      // The answer carries the settings the agent's monitors use and any offered version: data only, never a command.
      return envelopes.heartbeatResponse.parse({ serverTime: serverTime(), scanner: { hardwareIds: scannerIds }, watchedServices: { names: watched },
        intervals: { heartbeatSeconds: p.heartbeatSeconds, pollSeconds: reportedPollSeconds(await holdMs()), eventsPaceMs },
        ...(upgrade ? { upgrade: { version: upgrade } } : {}) });
    });

    scoped.post("/agent/v1/events", {
      // A gzip batch is decompressed as it streams in, and stops with 413 past 1 MB of JSON (a small bomb cannot expand without limit).
      preParsing: async (request, _reply, payload) => {
        if (String(request.headers["content-encoding"] ?? "").trim().toLowerCase() !== "gzip") return payload;
        const capped = new Capped(BODY_LIMIT);
        (payload as Readable).on("data", (chunk: Buffer) => { capped.receivedEncodedLength += chunk.length; });
        pipeline(payload as Readable, createGunzip(), capped, () => undefined);
        return capped;
      },
    }, async (request, reply) => {
      const batch = envelopes.eventBatch.parse(request.body);
      const hour = Math.floor(Date.now() / 3_600_000);
      const count = eventCounts.get(request.cabinet!.id);
      const used = count && count.hour === hour ? count.n : 0;
      if (used + batch.events.length > eventsPerHour) return reply.code(429).header("retry-after", String(retryAfter())).send({ error: "rate_limited" });
      eventCounts.set(request.cabinet!.id, { hour, n: used + batch.events.length });
      if (eventCounts.size > 50_000) for (const [k, v] of eventCounts) if (v.hour !== hour) eventCounts.delete(k);
      await storeEvents(o.pool, request.cabinet!.id, batch);
      return { serverTime: serverTime() };
    });

    // The only file download on this API: an approved package, while this cabinet has an open package.install command for it.
    scoped.get<{ Params: { packageId: string } }>("/agent/v1/packages/:packageId", async (request, reply) => {
      if (!o.packages || !UUID.test(request.params.packageId)) return reply.code(404).send({ error: "not_found" });
      const file = await downloadablePath(o.pool, o.packages, request.cabinet!.id, request.params.packageId.toLowerCase());
      if (!file) return reply.code(404).send({ error: "not_found" });
      await transaction(o.pool, c => audit(c, { actorKind: "agent", actorId: request.cabinet!.id, action: "package.download", targetKind: "cabinet", targetId: request.cabinet!.id,
        outcome: "succeeded", details: { packageId: request.params.packageId.toLowerCase(), size: file.size } }));
      return reply.type("application/octet-stream").header("Content-Length", String(file.size)).header("Cache-Control", "no-store").send(createReadStream(file.path));
    });

    // A signed agent release, only to a cabinet a rollout has offered it to: the manifest exactly as signed and its signature...
    scoped.get<{ Params: { version: string } }>("/agent/v1/updates/:version", async (request, reply) => {
      const release = await releaseForAgent(o.pool, request.cabinet!.id, request.params.version);
      if (!release) return reply.code(404).send({ error: "not_found" });
      return envelopes.updateResponse.parse({ version: request.params.version, ...release });
    });

    // ...and its package zip. The agent's broker checks all of it against its own compiled-in key before installing anything.
    scoped.get<{ Params: { version: string } }>("/agent/v1/updates/:version/package", async (request, reply) => {
      if (!o.releases) return reply.code(404).send({ error: "not_found" });
      const file = await releasePackageForAgent(o.pool, o.releases, request.cabinet!.id, request.params.version);
      if (!file) return reply.code(404).send({ error: "not_found" });
      await transaction(o.pool, c => audit(c, { actorKind: "agent", actorId: request.cabinet!.id, action: "release.download", targetKind: "cabinet", targetId: request.cabinet!.id,
        outcome: "succeeded", details: { version: request.params.version, size: file.size } }));
      return reply.type("application/octet-stream").header("Content-Length", String(file.size)).header("Cache-Control", "no-store").send(createReadStream(file.path));
    });

    // How an offered upgrade ended: succeeded, refused (with the exact failed check), rolled back or failed.
    scoped.post("/agent/v1/upgrade-status", async (request, reply) => {
      const recorded = await recordUpgradeStatus(o.pool, request.cabinet!.id, envelopes.upgradeStatus.parse(request.body));
      if (!recorded) return reply.code(404).send({ error: "not_found" });
      return { serverTime: serverTime() };
    });

    scoped.post("/agent/v1/renew", async request => {
      const body = envelopes.renewRequest.parse(request.body);
      const issued = await renewCertificate(o.pool, o.issuingKey, request.cabinet!, body.csr);
      return envelopes.renewResponse.parse({ certificate: issued.pem, caChain: o.issuingKey.certificatePem, serverTime: serverTime() });
    });
  });

  return app;
}

// The agent API (docs/spec/03-protocol.md): its own listener, mutual TLS
// terminated by Node itself so the client certificate is checked directly.
// Every body is validated against its contract before anything reads it.
import type { TLSSocket } from "node:tls";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ContractError, envelopes } from "../contracts.js";
import { audit, transaction, type Pool } from "../db/db.js";
import { CsrError, type IssuingKey } from "../pki/x509.js";
import { authenticate, recordHeartbeat, renewCertificate, type AuthenticatedCabinet } from "../services/cabinets.js";
import { storeResult, takeQueuedCommands } from "../services/commands.js";
import { enrollmentStatus, submitEnrollment } from "../services/enrollment.js";
import { Refused } from "../services/errors.js";
import { storeEvents } from "../services/events.js";
import { resolveOfflineFor } from "../services/alerts.js";
import { scannerIdsFor } from "../services/fleet.js";
import { evaluateTime } from "../services/time.js";
import { evaluateDrift } from "../services/firewall-policy.js";
import { watchLevels } from "../services/watched-services.js";
import type { CommandNotifier } from "./notifier.js";
import { createReadStream } from "node:fs";
import { downloadablePath, type PackageStore } from "../services/packages.js";
import { raiseSecurityAlert } from "../services/security.js";
import { releaseForAgent, releasePackageForAgent, type ReleaseStore } from "../services/releases.js";
import { anyRolloutRunning, offerFor, recordUpgradeStatus } from "../services/rollouts.js";

export interface AgentApiOptions {
  pool: Pool;
  issuingKey: IssuingKey;
  notifier: CommandNotifier;
  tls: { certPem: string; keyPem: string };
  longPollMs?: number;
  /** The software library's store, for package downloads; omitted where no packages exist (some tests). */
  packages?: PackageStore;
  /** The update store for signed agent releases; omitted where no releases exist (some tests). */
  releases?: ReleaseStore;
  /** Enrollment submissions allowed per source address per hour. */
  enrollPerHour?: number;
  /** How many events one cabinet may send in an hour before it is asked to slow down (its own queue holds the rest). */
  eventsPerHour?: number;
  logger?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const serverTime = (): string => new Date().toISOString();

declare module "fastify" {
  interface FastifyRequest { cabinet?: AuthenticatedCabinet }
}

export async function buildAgentApi(o: AgentApiOptions): Promise<FastifyInstance> {
  const app = Fastify({
    https: { key: o.tls.keyPem, cert: o.tls.certPem, ca: o.issuingKey.certificatePem, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.2" },
    bodyLimit: 1024 * 1024,
    logger: o.logger === false ? false : { level: "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    // 8,000 cabinets make hundreds of requests a second; each request is not logged (refusals and errors are, and
    // everything that matters is in the audit log).
    disableRequestLogging: true,
    return503OnClosing: true,
  });
  const longPollMs = o.longPollMs ?? 25_000;
  const enrollPerHour = o.enrollPerHour ?? 10;
  // The ingest quota (docs/platform/data-classification.md): per cabinet, per clock hour, kept in memory. Over it, a batch
  // is refused with 429 and the agent keeps the events in its own bounded queue and sends them later.
  const eventsPerHour = o.eventsPerHour ?? 3000;
  const eventCounts = new Map<string, { hour: number; n: number }>();
  const enrollAttempts = new Map<string, number[]>();
  const refusedLogged = new Map<string, number>();

  // Only JSON request bodies exist on this API.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, JSON.parse(body as string)); }
    catch { done(new Refused("invalid_json", 400, "body is not JSON"), undefined); }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Refused) return reply.code(error.status).send({ error: error.code });
    if (error instanceof ContractError) return reply.code(400).send({ error: "invalid_request", issues: error.issues });
    if (error instanceof CsrError) return reply.code(400).send({ error: "invalid_request" });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: "invalid_request" });
    request.log.error({ err: { type: (error as Error).name } }, "request failed");
    return reply.code(500).send({ error: "server_error" });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));

  /** Every route except enrollment and health needs a certificate this server issued to an active cabinet. */
  const requireCabinet = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const socket = request.raw.socket as TLSSocket;
    // The certificate the caller presented, whether or not it chains to our CA (empty when none was presented).
    const peer = socket.getPeerCertificate();
    const serial = /^[0-9A-Fa-f]{2,64}$/.test(peer?.serialNumber ?? "") ? peer.serialNumber.toUpperCase() : "";
    const subject = typeof peer?.subject?.CN === "string" ? peer.subject.CN : "";
    const cabinet = socket.authorized && serial ? await authenticate(o.pool, serial, subject) : null;
    if (!cabinet) {
      await noteRefusal(request, socket.authorized, serial, subject);
      return reply.code(401).send({ error: "certificate_refused" });
    }
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
    scoped.addHook("preHandler", requireCabinet);

    scoped.get("/agent/v1/commands", async request => {
      const cabinetId = request.cabinet!.id;
      const abort = new AbortController();
      request.raw.on("close", () => abort.abort());
      const deadline = Date.now() + longPollMs;
      // The database is checked when the poll arrives and again only when a command for this cabinet is announced
      // (or every 5 s while the announcement listener is reconnecting). The wake counter is read before the check, so a
      // command queued in between still ends the wait at once.
      let mark = o.notifier.mark(cabinetId);
      let commands = await takeQueuedCommands(o.pool, cabinetId);
      while (commands.length === 0 && Date.now() < deadline && !abort.signal.aborted) {
        const before = mark;
        await o.notifier.wait(cabinetId, o.notifier.listening ? deadline - Date.now() : Math.min(deadline - Date.now(), 5_000), abort.signal, before);
        if (abort.signal.aborted) break;
        mark = o.notifier.mark(cabinetId);
        if (mark === before && o.notifier.listening && Date.now() >= deadline - 5) break; // the poll simply ran out: nothing was announced
        commands = await takeQueuedCommands(o.pool, cabinetId);
      }
      return envelopes.commandsResponse.parse({ serverTime: serverTime(), commands });
    });

    scoped.post("/agent/v1/results", async request => {
      await storeResult(o.pool, request.cabinet!.id, envelopes.result.parse(request.body));
      return { serverTime: serverTime() };
    });

    scoped.post("/agent/v1/heartbeat", async request => {
      const cabinetId = request.cabinet!.id;
      const heartbeat = envelopes.heartbeat.parse(request.body);
      const { wasOffline, firewallChanged, timeCheck } = await recordHeartbeat(o.pool, cabinetId, heartbeat);
      if (wasOffline) await resolveOfflineFor(o.pool, cabinetId);
      // Compared with the client's firewall policy only when the profiles changed (or were first reported).
      if (firewallChanged) await evaluateDrift(o.pool, { cabinetId });
      // Compared with the site's time zone and the server's clock only when the zone changed or the clock is, or was, off.
      if (timeCheck) await evaluateTime(o.pool, { cabinetId });
      // A running rollout that has reached this cabinet's batch offers it the release (or notes that it already runs it).
      const upgrade = (await anyRolloutRunning(o.pool)) ? await transaction(o.pool, c => offerFor(c, cabinetId, heartbeat.agentVersion)) : null;
      // The answer carries the settings the agent's monitors use and any offered version: data only, never a command.
      return envelopes.heartbeatResponse.parse({ serverTime: serverTime(), scanner: { hardwareIds: await scannerIdsFor(o.pool, cabinetId) },
        watchedServices: { names: (await watchLevels(o.pool, cabinetId)).effective },
        ...(upgrade ? { upgrade: { version: upgrade } } : {}) });
    });

    scoped.post("/agent/v1/events", async (request, reply) => {
      const batch = envelopes.eventBatch.parse(request.body);
      const hour = Math.floor(Date.now() / 3_600_000);
      const count = eventCounts.get(request.cabinet!.id);
      const used = count && count.hour === hour ? count.n : 0;
      if (used + batch.events.length > eventsPerHour) return reply.code(429).send({ error: "rate_limited" });
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

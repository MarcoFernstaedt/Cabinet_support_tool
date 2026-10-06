// The agent API (docs/spec/03-protocol.md): its own listener, mutual TLS
// terminated by Node itself so the client certificate is checked directly.
// Every body is validated against its contract before anything reads it.
import type { TLSSocket } from "node:tls";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type pg from "pg";
import { ContractError, envelopes } from "../contracts.js";
import { audit, transaction } from "../db/db.js";
import { CsrError, type IssuingKey } from "../pki/x509.js";
import { authenticate, recordHeartbeat, renewCertificate, type AuthenticatedCabinet } from "../services/cabinets.js";
import { storeResult, takeQueuedCommands } from "../services/commands.js";
import { enrollmentStatus, submitEnrollment } from "../services/enrollment.js";
import { Refused } from "../services/errors.js";
import { storeEvents } from "../services/events.js";
import type { CommandNotifier } from "./notifier.js";

export interface AgentApiOptions {
  pool: pg.Pool;
  issuingKey: IssuingKey;
  notifier: CommandNotifier;
  tls: { certPem: string; keyPem: string };
  longPollMs?: number;
  /** Enrollment submissions allowed per source address per hour. */
  enrollPerHour?: number;
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
    disableRequestLogging: false,
    return503OnClosing: true,
  });
  const longPollMs = o.longPollMs ?? 25_000;
  const enrollPerHour = o.enrollPerHour ?? 10;
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
    const peer = socket.authorized ? socket.getPeerCertificate() : null;
    const serial = peer?.serialNumber?.toUpperCase() ?? "";
    const subject = typeof peer?.subject?.CN === "string" ? peer.subject.CN : "";
    const cabinet = peer && serial ? await authenticate(o.pool, serial, subject) : null;
    if (!cabinet) {
      await noteRefusal(request, socket.authorized ? `serial ${serial}` : "no valid certificate", serial);
      return reply.code(401).send({ error: "certificate_refused" });
    }
    request.cabinet = cabinet;
  };

  /** Logs a refused connection; a certificate signed by our CA but not accepted (revoked, unknown) is also audited, at most hourly per serial. */
  const noteRefusal = async (request: FastifyRequest, reason: string, serial: string): Promise<void> => {
    request.log.warn({ reason, remote: request.ip }, "agent connection refused");
    if (!serial) return;
    const last = refusedLogged.get(serial) ?? 0;
    if (Date.now() - last < 3_600_000) return;
    refusedLogged.set(serial, Date.now());
    await transaction(o.pool, c => audit(c, { actorKind: "agent", actorId: serial, action: "agent.connection_refused", outcome: "refused",
      details: { certificateSerial: serial, source: request.ip } })).catch(() => undefined);
  };

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/agent/v1/enroll", async (request, reply) => {
    const now = Date.now();
    const recent = (enrollAttempts.get(request.ip) ?? []).filter(t => now - t < 3_600_000);
    if (recent.length >= enrollPerHour) return reply.code(429).send({ error: "rate_limited" });
    recent.push(now);
    enrollAttempts.set(request.ip, recent);
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
      let commands = await takeQueuedCommands(o.pool, cabinetId);
      while (commands.length === 0 && Date.now() < deadline && !abort.signal.aborted) {
        await o.notifier.wait(cabinetId, Math.min(deadline - Date.now(), 5_000), abort.signal); // re-check at least every 5 s
        if (abort.signal.aborted) break;
        commands = await takeQueuedCommands(o.pool, cabinetId);
      }
      return envelopes.commandsResponse.parse({ serverTime: serverTime(), commands });
    });

    scoped.post("/agent/v1/results", async request => {
      await storeResult(o.pool, request.cabinet!.id, envelopes.result.parse(request.body));
      return { serverTime: serverTime() };
    });

    scoped.post("/agent/v1/heartbeat", async request => {
      await recordHeartbeat(o.pool, request.cabinet!.id, envelopes.heartbeat.parse(request.body));
      return { serverTime: serverTime() };
    });

    scoped.post("/agent/v1/events", async request => {
      await storeEvents(o.pool, request.cabinet!.id, envelopes.eventBatch.parse(request.body));
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

// The software library, the write pause and firewall history (docs/spec/06-console-spec.md
// "Software", "Firewall", "Admin screens"). Every body is checked against its contract and every
// change needs a step-up token for that exact action.
import { boundTo } from "../auth/stepup.js";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { consoleBodies } from "../contracts.js";
import { Refused } from "../services/errors.js";
import * as packages from "../services/packages.js";
import { setClientPause, setFleetPause, writeStatus } from "../services/writes.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function writeRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  // Package uploads are the one request body that is not JSON: the file itself, streamed and size-capped as it arrives.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));

  app.get("/api/writes/status", async request => { await o.guards.role(request, "tier1"); return writeStatus(o.pool); });

  app.post("/api/admin/writes", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.writePause.parse(request.body);
    await setFleetPause(o.pool, u.userId, body.paused, body.reason ?? null, boundTo(body.stepUpToken, body));
    return writeStatus(o.pool);
  });

  app.post("/api/admin/clients/:id/writes", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.writePause.parse(request.body);
    await setClientPause(o.pool, u.userId, id(request), body.paused, body.reason ?? null, boundTo(body.stepUpToken, body));
    return writeStatus(o.pool);
  });

  // ---- The software library ---------------------------------------------------------------

  /** Approved packages, for the cabinet's Software section. */
  app.get("/api/packages", async request => { await o.guards.role(request, "tier1"); return packages.listPackages(o.pool, true); });

  /** Every package in every state, for Admins. */
  app.get("/api/admin/packages", async request => { await o.guards.role(request, "admin"); return packages.listPackages(o.pool, false); });

  app.post("/api/admin/packages", async (request, reply) => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.packageUpload.parse(request.body);
    const packageId = await packages.startUpload(o.pool, u.userId, {
      name: body.name, version: body.version, vendor: body.vendor, packageType: body.packageType, hardwareIds: body.hardwareIds, ...(body.notes ? { notes: body.notes } : {}),
    }, boundTo(body.stepUpToken, body));
    return reply.code(201).send({ packageId });
  });

  app.put("/api/admin/packages/:id/content", async request => {
    const u = await o.guards.role(request, "admin");
    if (!o.packages) throw new Refused("unavailable", 503, "no package store is configured");
    if (request.headers["content-type"] !== "application/octet-stream") throw new Refused("invalid_request", 415, "send the file as application/octet-stream");
    const declared = Number(request.headers["content-length"] ?? "0");
    if (declared > o.packages.maxBytes) throw new Refused("too_large", 413, "the package is larger than the size limit");
    return packages.receiveUpload(o.pool, o.packages, u.userId, id(request), request.body as Readable);
  });

  app.post("/api/admin/packages/:id/approve", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await packages.approvePackage(o.pool, u.userId, id(request), boundTo(body.stepUpToken, body));
    return packages.packageById(o.pool, id(request));
  });

  app.post("/api/admin/packages/:id/retire", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await packages.retirePackage(o.pool, u.userId, id(request), boundTo(body.stepUpToken, body));
    return packages.packageById(o.pool, id(request));
  });

  // ---- Firewall history -------------------------------------------------------------------

  app.get("/api/cabinets/:id/firewall-history", async request => {
    await o.guards.role(request, "tier1");
    const rows = (await o.pool.query<{ id: string; command_id: string | null; explained: boolean; operation: string | null; before: unknown; after: unknown; detail: unknown;
      occurred_at: Date; issued_by_name: string | null }>(
      `SELECT TOP (200) f.id, f.command_id, f.explained, COALESCE(f.operation, c.operation) AS operation, f.[before], f.[after], f.detail, f.occurred_at, u.name AS issued_by_name
         FROM firewall_changes f LEFT JOIN commands c ON c.id = f.command_id LEFT JOIN users u ON u.id = c.issued_by
        WHERE f.cabinet_id = $1 ORDER BY f.occurred_at DESC`, [id(request)])).rows;
    return rows.map(r => ({ id: r.id, commandId: r.command_id, explained: r.explained, operation: r.operation, before: r.before, after: r.after, detail: r.detail,
      occurredAt: r.occurred_at.toISOString(), by: r.issued_by_name }));
  });
}

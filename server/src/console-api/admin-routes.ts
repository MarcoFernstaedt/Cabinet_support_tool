// Admin: the pending queue, bootstrap tokens and revoking cabinets (the other admin screens are in manage-routes.ts).
// Every change needs a step-up token for that exact action and target.
import { boundTo } from "../auth/stepup.js";
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { transaction } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { revokeCabinet } from "../services/cabinets.js";
import { approveEnrollment, createBootstrapToken, pendingRequests, rejectEnrollment } from "../services/enrollment.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function adminRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  /** Consumes the step-up token in its own transaction just before the action, which runs in the next. */
  const stepUp = (userId: string, token: string, action: string, target: string) =>
    transaction(o.pool, c => consumeStepUpToken(c, token, userId, action, target));

  app.get("/api/admin/enrollments", async request => {
    await o.guards.role(request, "admin");
    return pendingRequests(o.pool);
  });

  app.post("/api/admin/enrollments/:id/approve", async request => {
    const u = await o.guards.role(request, "admin");
    const requestId = id(request);
    const body = consoleBodies.approve.parse(request.body);
    await stepUp(u.userId, boundTo(body.stepUpToken, body), "enrollment.approve", requestId);
    // A satellite may name its sync cabinet; the server checks it is an active sync cabinet at the same site.
    return approveEnrollment(o.pool, o.issuingKey, requestId, { clientName: body.client, siteName: body.site, cabinetName: body.cabinet, role: body.role,
      ...(body.syncCabinetId ? { syncCabinetId: body.syncCabinetId.toLowerCase() } : {}) }, u.userId);
  });

  app.post("/api/admin/enrollments/:id/reject", async request => {
    const u = await o.guards.role(request, "admin");
    const requestId = id(request);
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await stepUp(u.userId, boundTo(body.stepUpToken, body), "enrollment.reject", requestId);
    await rejectEnrollment(o.pool, requestId, u.userId);
    return { status: "rejected" };
  });

  /** A one-time token for installing one cabinet, with the CA file the installer needs. Shown once. */
  app.post("/api/admin/bootstrap-tokens", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await stepUp(u.userId, boundTo(body.stepUpToken, body), "token.create", "fleet");
    const { token, expiresAt } = await createBootstrapToken(o.pool, u.userId);
    return { token, expiresAt: expiresAt.toISOString(), platformCaPem: o.issuingKey.certificatePem };
  });

  app.post("/api/admin/cabinets/:id/revoke", async request => {
    const u = await o.guards.role(request, "admin");
    const cabinetId = id(request);
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await stepUp(u.userId, boundTo(body.stepUpToken, body), "cabinet.revoke", cabinetId);
    await revokeCabinet(o.pool, cabinetId, u.userId);
    return { status: "removed" };
  });
}

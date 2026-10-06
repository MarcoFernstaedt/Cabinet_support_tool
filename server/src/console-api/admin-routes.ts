// Admin: the pending queue, bootstrap tokens, revoking cabinets and reading the audit log.
// Every change needs a step-up token for that exact action and target.
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
    await stepUp(u.userId, body.stepUpToken, "enrollment.approve", requestId);
    return approveEnrollment(o.pool, o.issuingKey, requestId, { clientName: body.client, siteName: body.site, cabinetName: body.cabinet, role: body.role }, u.userId);
  });

  app.post("/api/admin/enrollments/:id/reject", async request => {
    const u = await o.guards.role(request, "admin");
    const requestId = id(request);
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await stepUp(u.userId, body.stepUpToken, "enrollment.reject", requestId);
    await rejectEnrollment(o.pool, requestId, u.userId);
    return { status: "rejected" };
  });

  /** A one-time token for installing one cabinet, with the CA file the installer needs. Shown once. */
  app.post("/api/admin/bootstrap-tokens", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await stepUp(u.userId, body.stepUpToken, "token.create", "fleet");
    const { token, expiresAt } = await createBootstrapToken(o.pool, u.userId);
    return { token, expiresAt: expiresAt.toISOString(), platformCaPem: o.issuingKey.certificatePem };
  });

  app.post("/api/admin/cabinets/:id/revoke", async request => {
    const u = await o.guards.role(request, "admin");
    const cabinetId = id(request);
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await stepUp(u.userId, body.stepUpToken, "cabinet.revoke", cabinetId);
    await revokeCabinet(o.pool, cabinetId, u.userId);
    return { status: "removed" };
  });

  /** Who looked at what and when: newest first, filtered by cabinet or user. */
  app.get("/api/admin/audit", async request => {
    await o.guards.role(request, "admin");
    const q = request.query as Record<string, string | undefined>;
    const uuid = (v: string | undefined) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : null);
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return (await o.pool.query<{ seq: string; at: Date; actor_kind: string; actor_id: string; username: string | null; action: string;
      target_kind: string | null; target_id: string | null; outcome: string; details: unknown }>(
      `SELECT a.seq, a.at, a.actor_kind, a.actor_id, u.username, a.action, a.target_kind, a.target_id, a.outcome, a.details
         FROM audit_log a LEFT JOIN users u ON a.actor_kind = 'user' AND u.id::text = a.actor_id
        WHERE ($1::text IS NULL OR a.target_id = $1) AND ($2::text IS NULL OR (a.actor_kind = 'user' AND a.actor_id = $2))
        ORDER BY a.seq DESC LIMIT $3`, [uuid(q.cabinet), uuid(q.user), limit])).rows
      .map(r => ({ seq: Number(r.seq), at: r.at.toISOString(), actor: r.username ?? `${r.actor_kind}:${r.actor_id}`, action: r.action,
        targetKind: r.target_kind, targetId: r.target_id, outcome: r.outcome, details: r.details }));
  });
}

// Known fixes: what solved a problem, saved with its environment and shown when the problem comes back (docs/spec/14-network-troubleshooting.md).
// Anyone from Tier 1 submits one; an Admin, or a Tier 2 who has been granted it, approves or rejects; Tier 2 and up remove one. Every body and query is checked against its contract.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { environmentOf, listKnownFixes, pendingCount, removeKnownFix, reviewKnownFix, reviewQueue, saveKnownFix } from "../services/known-fixes.js";
import { Refused } from "../services/errors.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function knownFixRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  /** The fixes for one finding or issue type (or all of them), with the cabinet's environment now so the two can be compared. */
  app.get("/api/known-fixes", async request => {
    const u = await o.guards.role(request, "tier1");
    const q = consoleBodies.knownFixQuery.parse(request.query);
    return { fixes: await listKnownFixes(o.pool, { ...(q.findingKey ? { findingKey: q.findingKey } : {}), ...(q.issueTypeId ? { issueTypeId: q.issueTypeId } : {}) }, u.userId),
      now: q.cabinetId ? await environmentOf(o.pool, q.cabinetId) : null };
  });

  app.post("/api/known-fixes", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    return reply.code(201).send(await saveKnownFix(o.pool, u, consoleBodies.knownFixCreate.parse(request.body)));
  });

  app.post("/api/known-fixes/:id/remove", async request => {
    const u = await o.guards.role(request, "tier2");
    await removeKnownFix(o.pool, u.userId, id(request));
    return { ok: true };
  });

  /** How many are waiting, for the badge; only an approver is told. */
  app.get("/api/known-fixes/summary", async request => {
    const u = await o.guards.role(request, "tier1");
    return { canApprove: u.canApproveFixes, pending: u.canApproveFixes ? await pendingCount(o.pool) : 0 };
  });

  /** The review queue: what is waiting and the latest decisions. Approvers only. */
  app.get("/api/known-fixes/review", async request => {
    const u = await o.guards.role(request, "tier1");
    if (!u.canApproveFixes) throw new Refused("forbidden", 403, "only an Admin, or a Tier 2 who has been granted it, reviews fixes");
    return reviewQueue(o.pool);
  });

  app.post("/api/known-fixes/:id/approve", async request => {
    const u = await o.guards.role(request, "tier1");
    if (!u.canApproveFixes) throw new Refused("forbidden", 403, "only an Admin, or a Tier 2 who has been granted it, approves fixes");
    return reviewKnownFix(o.pool, u.userId, id(request), "approved");
  });

  app.post("/api/known-fixes/:id/reject", async request => {
    const u = await o.guards.role(request, "tier1");
    if (!u.canApproveFixes) throw new Refused("forbidden", 403, "only an Admin, or a Tier 2 who has been granted it, rejects fixes");
    const b = consoleBodies.knownFixReject.parse(request.body ?? {});
    return reviewKnownFix(o.pool, u.userId, id(request), "rejected", b.reason);
  });
}

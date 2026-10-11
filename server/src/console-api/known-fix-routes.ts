// Known fixes: what solved a problem, saved with its environment and shown when the problem comes back (docs/spec/14-network-troubleshooting.md).
// Anyone from Tier 1 saves one; Tier 2 and up remove one. Every body and query is checked against its contract.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { environmentOf, listKnownFixes, removeKnownFix, saveKnownFix } from "../services/known-fixes.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function knownFixRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  /** The fixes for one finding or issue type (or all of them), with the cabinet's environment now so the two can be compared. */
  app.get("/api/known-fixes", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.knownFixQuery.parse(request.query);
    return { fixes: await listKnownFixes(o.pool, { ...(q.findingKey ? { findingKey: q.findingKey } : {}), ...(q.issueTypeId ? { issueTypeId: q.issueTypeId } : {}) }),
      now: q.cabinetId ? await environmentOf(o.pool, q.cabinetId) : null };
  });

  app.post("/api/known-fixes", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    return reply.code(201).send(await saveKnownFix(o.pool, u.userId, consoleBodies.knownFixCreate.parse(request.body)));
  });

  app.post("/api/known-fixes/:id/remove", async request => {
    const u = await o.guards.role(request, "tier2");
    await removeKnownFix(o.pool, u.userId, id(request));
    return { ok: true };
  });
}

// One-click diagnoses (Tier 1). The commands a diagnosis issues are checked and audited as the person's own.
import type { FastifyInstance } from "fastify";
import { Refused } from "../services/errors.js";
import { diagnosis, latestDiagnosis, startNetworkDiagnosis } from "../diagnose/network.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function diagnoseRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.post("/api/cabinets/:id/diagnose/network", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    return reply.code(202).send({ diagnosisId: await startNetworkDiagnosis(o.pool, u, id(request), m => request.log.error(m)) });
  });
  app.get("/api/cabinets/:id/diagnose/network", async request => {
    await o.guards.role(request, "tier1");
    return { latest: await latestDiagnosis(o.pool, id(request)) };
  });
  app.get("/api/diagnoses/:id", async request => {
    await o.guards.role(request, "tier1");
    const d = await diagnosis(o.pool, id(request));
    if (!d) throw new Refused("not_found", 404, "no such diagnosis");
    return d;
  });
}

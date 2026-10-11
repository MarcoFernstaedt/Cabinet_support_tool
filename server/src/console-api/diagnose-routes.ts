// One-click diagnoses (Tier 1). The commands a diagnosis issues are checked and audited as the person's own.
import type { FastifyInstance } from "fastify";
import { Refused } from "../services/errors.js";
import { diagnosis, latestDiagnosis, networkBatch, startNetworkBatch, startNetworkDiagnosis } from "../diagnose/network.js";
import { consoleBodies } from "../contracts.js";
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
  // Many cabinets, or a whole site, at once (read only; each command is issued as the person who asked).
  app.post("/api/diagnose/network", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    const b = consoleBodies.networkDiagnosisStart.parse(request.body);
    return reply.code(202).send(await startNetworkBatch(o.pool, u, "siteId" in b ? { siteId: b.siteId } : { cabinetIds: b.cabinetIds }, m => request.log.error(m)));
  });
  app.get("/api/diagnose/network/batches/:id", async request => {
    await o.guards.role(request, "tier1");
    const b = await networkBatch(o.pool, id(request));
    if (!b) throw new Refused("not_found", 404, "no such diagnosis");
    return b;
  });

  app.get("/api/diagnoses/:id", async request => {
    await o.guards.role(request, "tier1");
    const d = await diagnosis(o.pool, id(request));
    if (!d) throw new Refused("not_found", 404, "no such diagnosis");
    return d;
  });
}

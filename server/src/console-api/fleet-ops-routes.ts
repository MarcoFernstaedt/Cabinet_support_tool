// Fleet operations (docs/spec/13-roadmap.md modules 21 and 45): list and choose cabinets, preview, start a job, follow it,
// cancel it. Tier 1 and up, as the operation's catalog role allows; every query and body is checked against its contract.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { Refused } from "../services/errors.js";
import { cancelJob, DEFAULT_TIMING, fleetCabinets, fleetSites, job, preview, recentJobs, runJob, startJob, type JobOperation } from "../services/fleet-jobs.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function fleetOpsRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  const timing = o.fleetJobTiming ?? DEFAULT_TIMING;

  app.get("/api/fleet-operations/sites", async request => { await o.guards.role(request, "tier1"); return { sites: await fleetSites(o.pool) }; });

  app.get("/api/fleet-operations/cabinets", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.fleetCabinetsQuery.parse(request.query);
    return fleetCabinets(o.pool, q);
  });

  app.post("/api/fleet-operations/preview", async request => {
    const u = await o.guards.role(request, "tier1");
    const b = consoleBodies.fleetPreview.parse(request.body);
    return preview(o.pool, u, b.operation as JobOperation, b.cabinetIds);
  });

  app.post("/api/fleet-operations/jobs", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    const b = consoleBodies.fleetJob.parse(request.body);
    const started = await startJob(o.pool, u, { ...b, operation: b.operation as JobOperation });
    void runJob(o.pool, started.jobId, timing, m => request.log.error(m));
    return reply.code(202).send(started);
  });

  app.get("/api/fleet-operations/jobs", async request => {
    await o.guards.role(request, "tier1");
    return { jobs: await recentJobs(o.pool) };
  });

  app.get("/api/fleet-operations/jobs/:id", async request => {
    await o.guards.role(request, "tier1");
    const j = await job(o.pool, id(request));
    if (!j) throw new Refused("not_found", 404, "no such job");
    return j;
  });

  app.post("/api/fleet-operations/jobs/:id/cancel", async request => {
    const u = await o.guards.role(request, "tier1");
    await cancelJob(o.pool, u, id(request));
    return { state: "cancelled" };
  });
}

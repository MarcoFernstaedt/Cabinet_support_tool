// Baselines and a cabinet's configuration (docs/spec/15-baselines-and-config.md). Every query string and body is checked against its
// contract; every role check is here. Reading is Tier 1; drafting, capturing, importing and proposing is Tier 2 (Admin for the baselines
// of all cabinets or a model); approving and rejecting is Admin, with an authenticator code bound to the written note.
// Nothing here sends anything to a cabinet or puts a cabinet's setting back: a comparison only reports.
import type { FastifyInstance } from "fastify";
import { boundTo } from "../auth/stepup.js";
import { consoleBodies } from "../contracts.js";
import * as baselines from "../services/baselines.js";
import { changesFor, currentConfig, fleetDifferenceGroup, fleetDifferences, isCategory } from "../services/config-service.js";
import { cabinetsInScope, driftFor, evaluateBaselineDrift } from "../services/baseline-drift.js";
import { compareWithHealthy, evaluateHealth, healthFor } from "../services/cabinet-health.js";
import { timelineFor } from "../services/cabinet-timeline.js";
import { Refused } from "../services/errors.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

const num = (v: string | undefined, d: number, max: number) => Math.max(1, Math.min(max, v === undefined ? d : Number(v)));

/** Re-evaluations started by an approval and not finished yet (tests wait for them; the server just lets them run). */
export const reevaluations = new Set<Promise<void>>();
export const reevaluationsSettled = async (): Promise<void> => { while (reevaluations.size > 0) await Promise.allSettled([...reevaluations]); };

export async function baselineRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  const cabinet = async (cabinetId: string) => {
    if (!(await o.pool.query("SELECT 1 AS x FROM cabinets WHERE id = $1", [cabinetId])).rows[0]) throw new Refused("not_found", 404, "no such cabinet");
    return cabinetId;
  };
  /** A route that takes no body accepts none, or an empty object. */
  const noBody = (body: unknown) => {
    if (body !== undefined && body !== null && !(typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)) throw new Refused("invalid_request", 400, "this request takes no body");
  };

  app.get("/api/baselines", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.baselinesQuery.parse(request.query);
    return { baselines: await baselines.listBaselines(o.pool, q) };
  });

  app.get("/api/baselines/:id", async request => {
    await o.guards.role(request, "tier1");
    const b = await baselines.getBaseline(o.pool, id(request));
    if (!b) throw new Refused("not_found", 404, "no such baseline");
    return b;
  });

  app.get("/api/baselines/versions/:id", async request => {
    await o.guards.role(request, "tier1");
    const v = await baselines.getVersion(o.pool, id(request));
    if (!v) throw new Refused("not_found", 404, "no such baseline version");
    return v;
  });

  app.post("/api/baselines/drafts", async (request, reply) => {
    const u = await o.guards.role(request, "tier2");
    const b = consoleBodies.baselineDraft.parse(request.body);
    return reply.code(201).send(await baselines.createDraft(o.pool, u, b));
  });

  app.post("/api/baselines/capture", async (request, reply) => {
    const u = await o.guards.role(request, "tier2");
    const b = consoleBodies.baselineCapture.parse(request.body);
    return reply.code(201).send(await baselines.captureDraft(o.pool, u, b));
  });

  app.post("/api/baselines/import", async (request, reply) => {
    const u = await o.guards.role(request, "tier2");
    const b = consoleBodies.baselineImport.parse(request.body);
    return reply.code(201).send(await baselines.importDraft(o.pool, u, b));
  });

  app.put("/api/baselines/versions/:id", async request => {
    const u = await o.guards.role(request, "tier2");
    const b = consoleBodies.baselineUpdate.parse(request.body);
    await baselines.updateDraft(o.pool, u, id(request), b);
    return { ok: true };
  });

  for (const [path, run] of [["propose", baselines.propose], ["withdraw", baselines.withdraw]] as const)
    app.post(`/api/baselines/versions/:id/${path}`, async request => {
      const u = await o.guards.role(request, "tier2");
      noBody(request.body);
      await run(o.pool, u, id(request));
      return { ok: true };
    });

  for (const [path, approve] of [["approve", true], ["reject", false]] as const)
    app.post(`/api/baselines/versions/:id/${path}`, async request => {
      const u = await o.guards.role(request, "admin");
      const b = consoleBodies.baselineDecision.parse(request.body);
      const scope = await baselines.decide(o.pool, u, id(request), approve, b.note, boundTo(b.stepUpToken, b));
      // An approval changes what every cabinet in the scope is compared with: bring their drift and health up to date in the background, one at a time.
      if (approve) {
        const run = (async () => { for (const c of await cabinetsInScope(o.pool, scope)) { await evaluateBaselineDrift(o.pool, c); await evaluateHealth(o.pool, c); } })()
          .catch(e => app.log.error({ err: { type: (e as Error).name } }, "re-evaluating after a baseline decision failed"))
          .finally(() => reevaluations.delete(run));
        reevaluations.add(run);
      }
      return { ok: true };
    });

  // ---- One cabinet ----------------------------------------------------------------------------
  app.get("/api/cabinets/:id/baseline", async request => { await o.guards.role(request, "tier1"); return baselines.resolveForCabinet(o.pool, await cabinet(id(request))); });
  app.get("/api/cabinets/:id/config", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.cabinetHistoryQuery.parse(request.query);
    return { categories: await currentConfig(o.pool, await cabinet(id(request)), q.category) };
  });
  // The configuration health: judged against the baseline in force (the load samples have their own route, /api/cabinets/:id/health).
  // With it, whether a baseline is in force at all ("Baseline required" until one is) and what was decided for it at enrollment.
  app.get("/api/cabinets/:id/condition", async request => {
    await o.guards.role(request, "tier1");
    const cabinetId = await cabinet(id(request));
    return { ...(await healthFor(o.pool, cabinetId)), baseline: await baselines.baselineStatus(o.pool, cabinetId) };
  });
  app.get("/api/cabinets/:id/drift", async request => { await o.guards.role(request, "tier1"); return { drift: await driftFor(o.pool, await cabinet(id(request))) }; });
  app.get("/api/cabinets/:id/config-changes", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.cabinetHistoryQuery.parse(request.query);
    if (q.category && !isCategory(q.category)) throw new Refused("invalid_request", 400, "unknown category");
    return { changes: await changesFor(o.pool, await cabinet(id(request)), { category: q.category, days: num(q.days, 14, 90), q: q.q, violations: q.violations === "true", limit: num(q.limit, 200, 500) }) };
  });
  app.get("/api/cabinets/:id/config-history", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.cabinetHistoryQuery.parse(request.query);
    return timelineFor(o.pool, await cabinet(id(request)), { days: num(q.days, 14, 90), q: q.q, limit: num(q.limit, 200, 500) });
  });
  app.get("/api/cabinets/:id/compare-healthy", async request => {
    await o.guards.role(request, "tier1");
    return (await compareWithHealthy(o.pool, await cabinet(id(request)))) ?? { markId: null, markedAt: null, changes: [], unavailable: [] };
  });

  // ---- The fleet ------------------------------------------------------------------------------
  app.get("/api/fleet/differences", async request => {
    await o.guards.role(request, "tier1");
    return fleetDifferences(o.pool, consoleBodies.fleetDifferencesQuery.parse(request.query));
  });
  app.get("/api/fleet/differences/group", async request => {
    await o.guards.role(request, "tier1");
    return fleetDifferenceGroup(o.pool, consoleBodies.fleetDifferenceGroupQuery.parse(request.query));
  });
}

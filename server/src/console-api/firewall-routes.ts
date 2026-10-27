// The firewall policy (fleet, client and site levels) and the bulk apply (docs/spec/12-milestones-8-to-12.md, milestone 9). Every body and
// query is checked against its contract; roles are checked here, never only in the console.
import { boundTo } from "../auth/stepup.js";
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { bulkApply, bulkCandidates, cabinetPolicy, fleetPolicy, setClientPolicy, setFleetPolicy, setSitePolicy, sitePolicy, BULK_LIMIT } from "../services/firewall-policy.js";
import { Refused } from "../services/errors.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function firewallRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  /** The policy that applies to one cabinet and whether the cabinet differs from it. */
  app.get("/api/cabinets/:id/firewall-policy", async request => {
    await o.guards.role(request, "tier1");
    const p = await cabinetPolicy(o.pool, id(request));
    return { policy: p.policy, source: p.source, reported: p.reported, differs: p.differs, readOnly: p.readOnly };
  });

  app.get("/api/clients/:id/firewall-policy", async request => {
    await o.guards.role(request, "tier1");
    const row = (await o.pool.query<{ firewall_policy: unknown }>("SELECT firewall_policy FROM clients WHERE id = $1 AND removed_at IS NULL", [id(request)])).rows[0];
    if (!row) throw new Refused("not_found", 404, "no such client");
    return { own: row.firewall_policy, fleet: await fleetPolicy(o.pool) };
  });

  app.put("/api/clients/:id/firewall-policy", async request => {
    const u = await o.guards.role(request, "admin");
    const b = consoleBodies.firewallPolicy.parse(request.body);
    await setClientPolicy(o.pool, u.userId, id(request), b.policy, boundTo(b.stepUpToken, b));
    return { ok: true };
  });

  /** A site's own policy and the two it would otherwise follow. */
  app.get("/api/sites/:id/firewall-policy", async request => {
    await o.guards.role(request, "tier1");
    const p = await sitePolicy(o.pool, id(request));
    return { own: p.own, client: p.client, fleet: p.fleet, policy: p.policy, source: p.source };
  });

  app.put("/api/sites/:id/firewall-policy", async request => {
    const u = await o.guards.role(request, "admin");
    const b = consoleBodies.firewallPolicy.parse(request.body);
    await setSitePolicy(o.pool, u.userId, id(request), b.policy, boundTo(b.stepUpToken, b));
    return { ok: true };
  });

  app.get("/api/admin/firewall-policy", async request => { await o.guards.role(request, "tier1"); return { policy: await fleetPolicy(o.pool) }; });

  app.put("/api/admin/firewall-policy", async request => {
    const u = await o.guards.role(request, "admin");
    const b = consoleBodies.firewallPolicy.parse(request.body);
    await setFleetPolicy(o.pool, u.userId, b.policy, boundTo(b.stepUpToken, b));
    return { ok: true };
  });

  /** Which cabinets a bulk apply would change, before the person confirms it. */
  app.get("/api/bulk/firewall-policy", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.bulkScope.parse(request.query);
    const cabinets = await bulkCandidates(o.pool, q.scope, q.id);
    return { cabinets: cabinets.map(c => ({ id: c.id, name: c.name })), limit: BULK_LIMIT };
  });

  app.post("/api/bulk/firewall-policy", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    const b = consoleBodies.bulkFirewallPolicy.parse(request.body);
    return reply.code(202).send(await bulkApply(o.pool, u.userId, b.scope, b.id, b.stepUpToken));
  });
}

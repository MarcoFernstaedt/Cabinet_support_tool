// Incident records (docs/spec/18-built-designs.md §2, item 6): read only, Tier 1 and up, always
// within one cabinet so a record is never reached through another cabinet's page. Every query string is checked against its contract
// first. A person named in a record is shown by name; one no longer in the platform shows as "a removed account".
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import type { Queryable } from "../db/db.js";
import { Refused } from "../services/errors.js";
import { cabinetIncidents, getIncident, openIncidents, type Actor } from "../services/incidents.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

/** An actor as the console shows it: a person's name, or the platform part that acted. */
export type ShownActor = { kind: "user"; name: string } | { kind: "system"; name: string };

async function names(db: Queryable, actors: readonly Actor[]): Promise<(a: Actor) => ShownActor> {
  const ids = [...new Set(actors.flatMap(a => (a.kind === "user" ? [a.userId] : [])))];
  const rows = ids.length ? (await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM users WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [ids])).rows : [];
  const byId = new Map(rows.map(r => [r.id.toLowerCase(), r.name]));
  return a => (a.kind === "user" ? { kind: "user", name: byId.get(a.userId) ?? "a removed account" } : { kind: "system", name: a.name });
}

export async function incidentRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  // The fleet's open incidents for triage: Tier 1 and up, read only, like a cabinet's own list. Each names its cabinet, so it is opened
  // through that cabinet's page.
  app.get("/api/incidents/open", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.openIncidentsQuery.parse(request.query);
    return { incidents: await openIncidents(o.pool, { ...(q.clientId !== undefined ? { clientId: q.clientId } : {}), limit: q.limit === undefined ? 100 : Number(q.limit) }) };
  });
  app.get("/api/cabinets/:id/incidents", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.incidentQuery.parse(request.query);
    const cabinetId = id(request);
    if (!(await o.pool.query("SELECT 1 FROM cabinets WHERE id = $1", [cabinetId])).rows[0]) throw new Refused("not_found", 404, "no such cabinet");
    const list = await cabinetIncidents(o.pool, cabinetId, Number(q.limit ?? 50));
    const show = await names(o.pool, list.map(i => i.openedBy));
    return list.map(i => ({ ...i, openedBy: show(i.openedBy) }));
  });
  app.get("/api/cabinets/:id/incidents/:incidentId", async request => {
    await o.guards.role(request, "tier1");
    const cabinetId = id(request);
    const incident = await getIncident(o.pool, id(request, "incidentId"));
    // An incident of another cabinet is not found here, exactly like one that does not exist.
    if (!incident || incident.cabinetId !== cabinetId.toLowerCase()) throw new Refused("not_found", 404, "no such incident on this cabinet");
    const show = await names(o.pool, [incident.openedBy, ...incident.steps.map(s => s.actor)]);
    return { ...incident, openedBy: show(incident.openedBy), steps: incident.steps.map(s => ({ ...s, actor: show(s.actor) })) };
  });
}

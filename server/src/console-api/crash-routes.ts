// Crash investigation (Tier 1): one cabinet's crashes and what changed before them, its timeline, and the fleet view of a
// crash incident. Read only; every query string is checked against the crash-query contract first.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { transaction } from "../db/db.js";
import { Refused } from "../services/errors.js";
import { cabinetCrashes, fleetCrashIncident, timeline } from "../services/crashes.js";
import { exportEvidence } from "../services/evidence.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

const DAY = 86_400_000;
const MAX_DAYS = 90;
/** The fleet incident reads every cabinet's events, so its window is shorter and one user runs one at a time. */
const INCIDENT_MAX_DAYS = 14;
const incidentRunning = new Set<string>();

function window(q: { days?: string; from?: string; to?: string }, defaultDays: number, maxDays = MAX_DAYS): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - Number(q.days ?? defaultDays) * DAY);
  if (!(from < to)) throw new Refused("invalid_window", 400, "from must be before to");
  if (to.getTime() - from.getTime() > maxDays * DAY) throw new Refused("invalid_window", 400, `the window is at most ${maxDays} days`);
  return { from, to };
}

export async function crashRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.get("/api/cabinets/:id/crashes", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.crashQuery.parse(request.query);
    const cabinetId = id(request);
    if (!(await o.pool.query("SELECT 1 FROM cabinets WHERE id = $1", [cabinetId])).rows[0]) throw new Refused("not_found", 404, "no such cabinet");
    return cabinetCrashes(o.pool, cabinetId, Number(q.days ?? 30));
  });
  app.get("/api/cabinets/:id/timeline", async request => {
    await o.guards.role(request, "tier1");
    const w = window(consoleBodies.crashQuery.parse(request.query), 7);
    return { ...w, items: await timeline(o.pool, id(request), w.from, w.to) };
  });
  // An evidence package: what the platform holds about one cabinet for a period, hashed, with provenance; the export is audited.
  app.get("/api/cabinets/:id/evidence", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    const w = window(consoleBodies.crashQuery.parse(request.query), 30);
    const pkg = await exportEvidence(o.pool, id(request), w.from, w.to, { userId: u.userId, name: u.name });
    if (!pkg) throw new Refused("not_found", 404, "no such cabinet");
    const day = w.to.toISOString().slice(0, 10);
    return reply.header("content-disposition", `attachment; filename="evidence-${pkg.manifest.cabinetId}-${day}.json"`).send(pkg);
  });

  app.get("/api/incidents/crashes", async request => {
    const user = await o.guards.role(request, "tier1");
    const q = consoleBodies.crashQuery.parse(request.query);
    const w = window(q, 3, INCIDENT_MAX_DAYS);
    if (incidentRunning.has(user.userId)) throw new Refused("rate_limited", 429, "your previous incident query is still running");
    incidentRunning.add(user.userId);
    try {
      return await transaction(o.pool, async c => {
        await c.query("SET LOCAL statement_timeout = '15s'");
        return fleetCrashIncident(c, { ...w, clientId: q.clientId });
      });
    } finally { incidentRunning.delete(user.userId); }
  });
}

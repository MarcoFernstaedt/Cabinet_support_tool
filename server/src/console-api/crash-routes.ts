// Crash investigation (Tier 1): one cabinet's crashes and what changed before them, its timeline, and the fleet view of a
// crash incident. Read only; every query string is checked against the crash-query contract first.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { Refused } from "../services/errors.js";
import { cabinetCrashes, fleetCrashIncident, timeline } from "../services/crashes.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

const DAY = 86_400_000;
const MAX_DAYS = 90;

function window(q: { days?: string; from?: string; to?: string }, defaultDays: number): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - Number(q.days ?? defaultDays) * DAY);
  if (!(from < to)) throw new Refused("invalid_window", 400, "from must be before to");
  if (to.getTime() - from.getTime() > MAX_DAYS * DAY) throw new Refused("invalid_window", 400, `the window is at most ${MAX_DAYS} days`);
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
  app.get("/api/incidents/crashes", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.crashQuery.parse(request.query);
    return fleetCrashIncident(o.pool, { ...window(q, 3), clientId: q.clientId });
  });
}

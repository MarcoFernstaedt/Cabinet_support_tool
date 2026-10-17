// What is already known from earlier reads (Tier 1): a cabinet's latest stored answers (also while it is offline), a search across the
// fleet over those answers, and a cabinet's load samples. Nothing here sends a command to any cabinet. Query strings are checked
// against their contracts first, and the search is audited like any other look at fleet data.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { audit } from "../db/db.js";
import { Refused } from "../services/errors.js";
import { cabinetDrives, drivesAtRisk } from "../services/drives.js";
import { healthHistory, latestReading, latestReadings, searchReadings } from "../services/readings.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

/** A search scans every cabinet's stored reading, so one person runs one at a time and each is given up on after 15 seconds. */
const searching = new Set<string>();
const SEARCH_LIMIT_MS = 15_000;

/**
 * SQL Server has no per-transaction statement timeout (PostgreSQL's SET LOCAL statement_timeout), so the wait is limited here: after the
 * limit the person gets an answer and the search is abandoned. The statement itself is stopped by the connection pool's request timeout.
 */
function withinLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Refused("search_too_slow", 503, "the search took longer than 15 seconds; narrow it to one client or site")), ms);
  });
  work.catch(() => undefined); // a result that arrives after the limit is dropped, not reported twice
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export async function readingRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  const cabinet = async (cabinetId: string) => {
    if (!(await o.pool.query("SELECT 1 FROM cabinets WHERE id = $1", [cabinetId])).rows[0]) throw new Refused("not_found", 404, "no such cabinet");
    return cabinetId;
  };
  app.get("/api/cabinets/:id/readings", async request => {
    await o.guards.role(request, "tier1");
    return { readings: await latestReadings(o.pool, await cabinet(id(request))) };
  });
  app.get("/api/cabinets/:id/readings/:operation", async request => {
    await o.guards.role(request, "tier1");
    // No stored answer is an ordinary answer, not an error: the page shows the reading when there is one.
    return { reading: await latestReading(o.pool, await cabinet(id(request)), (request.params as { operation: string }).operation) };
  });
  app.get("/api/cabinets/:id/health", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.healthQuery.parse(request.query);
    return { hours: Number(q.hours ?? 24), points: await healthHistory(o.pool, await cabinet(id(request)), Number(q.hours ?? 24)) };
  });
  // Each drive's level of concern and its history, and the drives that are a concern anywhere in the fleet.
  app.get("/api/cabinets/:id/drives", async request => {
    await o.guards.role(request, "tier1");
    return { drives: await cabinetDrives(o.pool, await cabinet(id(request))) };
  });
  app.get("/api/fleet/drives-at-risk", async request => {
    await o.guards.role(request, "tier1");
    return { drives: await drivesAtRisk(o.pool) };
  });
  app.get("/api/readings/search", async request => {
    const u = await o.guards.role(request, "tier1");
    const q = consoleBodies.readingSearch.parse(request.query);
    if (searching.has(u.userId)) throw new Refused("rate_limited", 429, "your previous search is still running");
    searching.add(u.userId);
    let result;
    try {
      result = await withinLimit(searchReadings(o.pool, q.operation, q.q, { ...(q.clientId ? { clientId: q.clientId } : {}), ...(q.siteId ? { siteId: q.siteId } : {}) }), SEARCH_LIMIT_MS);
    } finally { searching.delete(u.userId); }
    await audit(o.pool, { actorKind: "user", actorId: u.userId, action: "readings.search", outcome: "succeeded", details: { operation: q.operation, q: q.q, matches: result.matches.length } });
    return result;
  });
}

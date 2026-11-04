// Crash investigation (Tier 1): one cabinet's crashes and what changed before them, its timeline, and the fleet view of a
// crash incident. Read only; every query string is checked against the crash-query contract first.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { Refused } from "../services/errors.js";
import { cabinetCrashes, fleetCrashIncident, timeline } from "../services/crashes.js";
import { scannerHistory } from "../services/scanner-history.js";
import { fleetPatternReport, listFleetPatterns } from "../services/fleet-patterns.js";
import { buildEvidence } from "../services/evidence.js";
import { encryptEvidence } from "../services/evidence-crypto.js";
import { audit, transaction } from "../db/db.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";
import { HEAVY_LIMIT_MS, HeavyQuery } from "./heavy.js";

const evidenceExports = new HeavyQuery("evidence export", HEAVY_LIMIT_MS);

const DAY = 86_400_000;
const MAX_DAYS = 90;
/** The fleet incident reads every cabinet's events, so its window is shorter and one user runs one at a time. */
const INCIDENT_MAX_DAYS = 14;
/** SQL Server has no per-statement timeout to set from here (the pool's own limit is 30 s), so the request gives up after this long. */
const INCIDENT_TIMEOUT_MS = 15_000;
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
  // Fleet patterns (D22): the same problem at many sites, with who has it and what they have in common. Tier 1 and up, read only.
  app.get("/api/fleet-patterns", async request => {
    await o.guards.role(request, "tier1");
    return { patterns: await listFleetPatterns(o.pool) };
  });
  app.get("/api/fleet-patterns/:id", async request => {
    await o.guards.role(request, "tier1");
    const report = await fleetPatternReport(o.pool, id(request));
    if (!report) throw new Refused("not_found", 404, "no such fleet pattern");
    return report;
  });
  app.get("/api/cabinets/:id/scanner-history", async request => {
    await o.guards.role(request, "tier1");
    const cabinetId = id(request);
    if (!(await o.pool.query("SELECT 1 FROM cabinets WHERE id = $1", [cabinetId])).rows[0]) throw new Refused("not_found", 404, "no such cabinet");
    return scannerHistory(o.pool, cabinetId);
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
    // Built under a time limit, one at a time per person; its export is audited as exportEvidence does.
    const pkg = await evidenceExports.run(u.userId, o.pool, db => buildEvidence(db, id(request), w.from, w.to, { userId: u.userId, name: u.name }));
    if (!pkg) throw new Refused("not_found", 404, "no such cabinet");
    await transaction(o.pool, c => audit(c, { actorKind: "user", actorId: u.userId, action: "evidence.export", targetKind: "cabinet", targetId: pkg.manifest.cabinetId,
      outcome: "succeeded", details: { from: w.from.toISOString(), to: w.to.toISOString(), packageSha256: pkg.manifest.packageSha256 } }));
    const day = w.to.toISOString().slice(0, 10);
    return reply.header("content-disposition", `attachment; filename="evidence-${pkg.manifest.cabinetId}-${day}.json"`).send(pkg);
  });

  // The same package, encrypted with a passphrase the person chooses (POST, so the passphrase never appears in a URL or a log). The audit entry
  // records that it was encrypted; the passphrase is neither stored nor logged.
  app.post("/api/cabinets/:id/evidence/encrypted", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    const body = consoleBodies.evidenceExport.parse(request.body);
    const w = window({ days: body.days }, 30);
    const pkg = await evidenceExports.run(u.userId, o.pool, db => buildEvidence(db, id(request), w.from, w.to, { userId: u.userId, name: u.name }));
    if (!pkg) throw new Refused("not_found", 404, "no such cabinet");
    await transaction(o.pool, c => audit(c, { actorKind: "user", actorId: u.userId, action: "evidence.export", targetKind: "cabinet", targetId: pkg.manifest.cabinetId,
      outcome: "succeeded", details: { from: w.from.toISOString(), to: w.to.toISOString(), packageSha256: pkg.manifest.packageSha256, encrypted: true } }));
    const day = w.to.toISOString().slice(0, 10);
    return reply.header("content-type", "application/octet-stream").header("content-disposition", `attachment; filename="evidence-${pkg.manifest.cabinetId}-${day}.cabev"`)
      .send(encryptEvidence(Buffer.from(JSON.stringify(pkg), "utf8"), body.passphrase));
  });

  app.get("/api/incidents/crashes", async request => {
    const user = await o.guards.role(request, "tier1");
    const q = consoleBodies.crashQuery.parse(request.query);
    const w = window(q, 3, INCIDENT_MAX_DAYS);
    if (incidentRunning.has(user.userId)) throw new Refused("rate_limited", 429, "your previous incident query is still running");
    incidentRunning.add(user.userId);
    // The user stays "running" until the query itself ends, even if the request gave up on it.
    const run = fleetCrashIncident(o.pool, { ...w, clientId: q.clientId });
    run.then(() => incidentRunning.delete(user.userId), () => incidentRunning.delete(user.userId));
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([run, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Refused("query_timeout", 503, "the incident query took too long; narrow the window or the client")), INCIDENT_TIMEOUT_MS); })]);
    } finally { clearTimeout(timer); }
  });
}

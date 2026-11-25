// The console's fleet-wide views at 10,000 cabinets (F21.R4): each view's own service call against a seeded fleet, timed. Not part of
// the suite: run it by hand on a quiet machine, RESOLVED resolved alerts a cabinet (default 20),
//   node dist/test/fleet-views-at-scale.bench.js
import { randomUUID } from "node:crypto";
import * as alerts from "../src/services/alerts.js";
import * as fleet from "../src/services/fleet.js";
import { fleetSafety } from "../src/services/admin.js";
import { compatibilityReport } from "../src/services/compatibility.js";
import { fleetDifferences } from "../src/services/config-service.js";
import { fleetCrashIncident } from "../src/services/crashes.js";
import { fleetCabinets } from "../src/services/fleet-jobs.js";
import { listFleetPatterns } from "../src/services/fleet-patterns.js";
import { openIncidents } from "../src/services/incidents.js";
import { healthSummary } from "../src/services/ops-health.js";
import { runbookOverview } from "../src/services/runbooks.js";
import { triage } from "../src/services/triage.js";
import { createPool } from "../src/db/db.js";
import { createTestDatabase } from "./database.js";

const CLIENTS = 20, SITES_PER_CLIENT = 25, CABINETS = 10_000, RESOLVED = Number(process.env.RESOLVED ?? 20), OPEN_EVERY = 5, NOISE = 30, CRASHING = 50, RUNS = 5;
const db = await createTestDatabase();
try {
  const t0 = Date.now();
  const owner = await createPool(db.ownerUrl, { max: 2, requestTimeoutMs: 1_800_000 });
  await owner.query(`INSERT INTO clients (id, name) SELECT NEWID(), CONCAT('Client ', n) FROM (SELECT TOP (${CLIENTS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x`);
  await owner.query(`INSERT INTO sites (id, client_id, name) SELECT NEWID(), c.id, CONCAT('Site ', n) FROM clients c CROSS JOIN (SELECT TOP (${SITES_PER_CLIENT}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x`);
  // 10,000 cabinets over the 500 sites; one in ten not heard from for a day.
  await owner.query(`INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at)
    SELECT NEWID(), s.id, CONCAT('K', s.rn, '-', n), 'standalone', 'active', CASE WHEN n % 10 = 0 THEN DATEADD(day, -1, SYSUTCDATETIME()) ELSE SYSUTCDATETIME() END
      FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM sites) s CROSS JOIN (SELECT TOP (${CABINETS / (CLIENTS * SITES_PER_CLIENT)}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x`);
  // A year of history: resolved alerts on every cabinet, and an open one on one cabinet in OPEN_EVERY, a third of those major.
  await owner.query(`INSERT INTO alerts (cabinet_id, severity, signature, title, state, first_seen, last_seen)
    SELECT k.id, 'minor', CONCAT('unrecognized:App:', n), 'An application error', 'resolved', DATEADD(day, -n * 18, SYSUTCDATETIME()), DATEADD(day, -n * 18 + 1, SYSUTCDATETIME())
      FROM cabinets k CROSS JOIN (SELECT TOP (${RESOLVED}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x`);
  await owner.query(`INSERT INTO alerts (cabinet_id, severity, signature, title, state, first_seen, last_seen)
    SELECT id, CASE WHEN rn % 3 = 0 THEN 'major' ELSE 'minor' END, 'unrecognized:Disk:7', 'Disk errors', 'open', DATEADD(hour, -5, SYSUTCDATETIME()), DATEADD(minute, -rn % 600, SYSUTCDATETIME())
      FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM cabinets) k WHERE rn % ${OPEN_EVERY} = 0`);
  // The everyday event volume: NOISE events a cabinet over the last day, and blue screens on CRASHING cabinets held by their alert.
  await owner.query(`INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail)
    SELECT NEWID(), k.id, 'error', DATEADD(second, -n * 2000, SYSUTCDATETIME()), '{"log":"System","source":"Service Control Manager","eventId":7036,"level":"information","recordId":1}', '{"message":"The service entered the running state."}'
      FROM cabinets k CROSS JOIN (SELECT TOP (${NOISE}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x`);
  await owner.query(`DECLARE @c TABLE (cabinet_id uniqueidentifier, alert_id uniqueidentifier);
    INSERT INTO @c SELECT TOP (${CRASHING}) id, NEWID() FROM cabinets ORDER BY id;
    INSERT INTO alerts (id, cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
      SELECT alert_id, cabinet_id, '00000000-0000-4000-8000-000000000109', 'major', 'issue:00000000-0000-4000-8000-000000000109', 'System crash', DATEADD(hour, -6, SYSUTCDATETIME()), SYSUTCDATETIME() FROM @c;
    INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail, alert_id)
      SELECT NEWID(), cabinet_id, 'error', DATEADD(hour, -2, SYSUTCDATETIME()), '{"log":"System","source":"BugCheck","eventId":1001,"level":"error","recordId":2}',
             '{"message":"The computer has rebooted from a bugcheck.  The bugcheck was: 0x0000007e (0xffffffffc0000005, 0xfffff8012a4b1c20, 0xffffd50f3a2e7a58, 0xffffd50f3a2e7290)."}', alert_id FROM @c;`);
  await owner.end();
  const count = async (t: string) => Number((await db.app.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n);
  console.log(`seeded ${await count("cabinets")} cabinets, ${await count("alerts")} alerts, ${await count("events")} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const me = randomUUID();
  const aClient = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM clients ORDER BY id")).rows[0]!.id;
  const aSite = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM sites ORDER BY id")).rows[0]!.id;
  const time = async (what: string, run: () => Promise<unknown>) => {
    await run(); // warm
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) { const s = process.hrtime.bigint(); await run(); ms.push(Number(process.hrtime.bigint() - s) / 1e6); }
    ms.sort((a, b) => a - b);
    console.log(`${what.padEnd(44)} median ${ms[Math.floor(RUNS / 2)]!.toFixed(0).padStart(6)} ms, best ${ms[0]!.toFixed(0)}, worst ${ms[RUNS - 1]!.toFixed(0)}`);
  };
  await time("alerts badge (summary)", () => alerts.summary(db.app));
  await time("alert list, active (default)", () => alerts.listAlerts(db.app, {}, me));
  await time("alert list, major only", () => alerts.listAlerts(db.app, { severity: "major" }, me));
  await time("alert list, one client", () => alerts.listAlerts(db.app, { clientId: aClient }, me));
  await time("alert list, resolved", () => alerts.listAlerts(db.app, { state: "resolved" }, me));
  await time("offline, by client", () => alerts.offline(db.app, {}));
  await time("fleet: clients", () => fleet.clients(db.app));
  await time("fleet: one client", () => fleet.client(db.app, aClient));
  await time("fleet: one site, first page", () => fleet.site(db.app, aSite));
  await time("fleet: search", () => fleet.search(db.app, "K12-3"));
  const day = { from: new Date(Date.now() - 3 * 86_400_000), to: new Date(Date.now() + 60_000) };
  await time("crash incident, 3 days", () => fleetCrashIncident(db.app, day));
  await time("open incidents", () => openIncidents(db.app, { limit: 100 }));
  await time("fleet patterns", () => listFleetPatterns(db.app));
  await time("triage", () => triage(db.app, {}));
  await time("fleet differences", () => fleetDifferences(db.app, {}));
  await time("fleet operations: cabinets", () => fleetCabinets(db.app, {}));
  await time("compatibility report", () => compatibilityReport(db.app));
  await time("runbook overview", () => runbookOverview(db.app));
  await time("admin: fleet safety", () => fleetSafety(db.app));
  await time("admin: system health", () => healthSummary(db.app));
} finally {
  await db.drop();
}

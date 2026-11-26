// The console's fleet reports at 10,000 cabinets (F21.R4, plan item 2.1), each against its own seeded data: open incidents, fleet
// differences, a person's activity report and the crash-signature list and report. Not part of the suite: run it by hand on a quiet
// machine,
//   node dist/test/fleet-reports-at-scale.bench.js
// and it prints the timings, which docs/platform/performance.md records with the machine they were measured on.
import { randomUUID } from "node:crypto";
import type { SessionUser } from "../src/auth/sessions.js";
import { activityReport } from "../src/services/activity-report.js";
import { fleetDifferenceGroup, fleetDifferences } from "../src/services/config-service.js";
import { crashSignatureReport, fleetCrashSignatures } from "../src/services/crash-signatures.js";
import { openIncidents } from "../src/services/incidents.js";
import { createPool } from "../src/db/db.js";
import { createTestDatabase } from "./database.js";

const CLIENTS = 20, SITES_PER_CLIENT = 25, CABINETS = 10_000, USERS = 50, RUNS = 5;
const INCIDENTS = 10, OPEN_EVERY = 10, DRIFT = 15, ALERTS = 20, COMMANDS = 20, NOISE = 30, CRASHING = 50;
const db = await createTestDatabase();
try {
  const t0 = Date.now();
  const owner = await createPool(db.ownerUrl, { max: 2, requestTimeoutMs: 1_800_000 });
  const rows = (n: number) => `(SELECT TOP (${n}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects)`;
  await owner.query(`INSERT INTO clients (id, name) SELECT NEWID(), CONCAT('Client ', n) FROM ${rows(CLIENTS)} x`);
  await owner.query(`INSERT INTO sites (id, client_id, name) SELECT NEWID(), c.id, CONCAT('Site ', n) FROM clients c CROSS JOIN ${rows(SITES_PER_CLIENT)} x`);
  await owner.query(`INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at)
    SELECT NEWID(), s.id, CONCAT('K', s.rn, '-', n), 'standalone', 'active', SYSUTCDATETIME()
      FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM sites) s CROSS JOIN ${rows(CABINETS / (CLIENTS * SITES_PER_CLIENT))} x`);
  await owner.query(`INSERT INTO users (id, username, name, role, password_hash) SELECT NEWID(), CONCAT('tech.', n), CONCAT('Tech ', n), 'tier2', 'x' FROM ${rows(USERS)} x`);
  // A year of work by USERS people: resolved alerts on every cabinet, and the commands of the last 30 days.
  await owner.query(`WITH u AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS i FROM users)
    INSERT INTO alerts (cabinet_id, severity, signature, title, state, first_seen, last_seen, resolved_by, resolved_at)
    SELECT k.id, 'minor', CONCAT('unrecognized:App:', n), 'An application error', 'resolved', DATEADD(day, -n * 18, SYSUTCDATETIME()), DATEADD(day, -n * 18 + 1, SYSUTCDATETIME()),
           u.id, DATEADD(day, -n * 18 + 1, SYSUTCDATETIME())
      FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM cabinets) k CROSS JOIN ${rows(ALERTS)} x JOIN u ON u.i = (k.rn + n) % ${USERS}`);
  await owner.query(`WITH u AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS i FROM users)
    INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result_at, result)
    SELECT NEWID(), k.id, 'system.info', '{}', u.id, DATEADD(minute, -n * 2160, SYSUTCDATETIME()), DATEADD(minute, -n * 2160 + 60, SYSUTCDATETIME()), 'succeeded',
           DATEADD(minute, -n * 2160 + 1, SYSUTCDATETIME()), '{"ok":true}'
      FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM cabinets) k CROSS JOIN ${rows(COMMANDS)} x JOIN u ON u.i = (k.rn + n) % ${USERS}`);
  // Incidents: INCIDENTS closed ones a cabinet over the year, an open one on one cabinet in OPEN_EVERY, three steps each.
  await owner.query(`INSERT INTO incidents (id, cabinet_id, state, symptom, opened_by_kind, opened_by, opened_at, updated_at, closed_at)
    SELECT NEWID(), k.id, 'resolved', 'The scanner is not detected', 'user', 'tech', DATEADD(day, -n * 30, SYSUTCDATETIME()), DATEADD(day, -n * 30 + 1, SYSUTCDATETIME()), DATEADD(day, -n * 30 + 1, SYSUTCDATETIME())
      FROM cabinets k CROSS JOIN ${rows(INCIDENTS)} x`);
  await owner.query(`INSERT INTO incidents (id, cabinet_id, state, symptom, opened_by_kind, opened_by, opened_at, updated_at)
    SELECT NEWID(), id, 'open', 'The cabinet does not sync', 'user', 'tech', DATEADD(hour, -rn % 72, SYSUTCDATETIME()), DATEADD(minute, -rn % 600, SYSUTCDATETIME())
      FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM cabinets) k WHERE rn % ${OPEN_EVERY} = 0`);
  await owner.query(`INSERT INTO incident_steps (incident_id, position, kind, actor_kind, actor_id, [at], summary)
    SELECT i.id, n, CASE n WHEN 1 THEN 'symptom' WHEN 2 THEN 'evidence' ELSE 'note' END, 'user', 'tech', DATEADD(minute, n, i.opened_at), CONCAT('Step ', n)
      FROM incidents i CROSS JOIN ${rows(3)} x`);
  // Differences from the baseline: DRIFT a cabinet over 30 services, every category reported, each cabinet judged.
  await owner.query(`INSERT INTO cabinet_drift (cabinet_id, category, item_key, field, mode, expected, actual, origin, severity, first_seen, last_seen)
    SELECT k.id, 'services', CONCAT('Service', (k.rn + n) % 30), 'state', 'match', '"running"', '"stopped"', '{"kind":"role"}', CASE WHEN n % 5 = 0 THEN 'major' ELSE 'minor' END,
           DATEADD(day, -n, SYSUTCDATETIME()), SYSUTCDATETIME()
      FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM cabinets) k CROSS JOIN ${rows(DRIFT)} x`);
  await owner.query(`INSERT INTO config_current (cabinet_id, category, hash, version_id, item_count, observed_at, changed_at)
    SELECT k.id, c.category, REPLICATE('a', 64), 1, 40, SYSUTCDATETIME(), SYSUTCDATETIME()
      FROM cabinets k CROSS JOIN (VALUES ('network'), ('services'), ('drivers'), ('updates'), ('firewall'), ('time'), ('devices'), ('applications'), ('hosts'), ('tasks'), ('system')) c (category)`);
  await owner.query(`INSERT INTO cabinet_health (cabinet_id, state, evaluated_at, since, reasons) SELECT id, 'degraded', SYSUTCDATETIME(), SYSUTCDATETIME(), '[]' FROM cabinets`);
  // The event volume, blue screens held by their alerts on CRASHING cabinets, and a program installed before each of them (and on a few others).
  await owner.query(`INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail)
    SELECT NEWID(), k.id, 'error', DATEADD(second, -n * 2000, SYSUTCDATETIME()), '{"log":"System","source":"Service Control Manager","eventId":7036,"level":"information","recordId":1}', '{"message":"The service entered the running state."}'
      FROM cabinets k CROSS JOIN ${rows(NOISE)} x`);
  await owner.query(`DECLARE @c TABLE (cabinet_id uniqueidentifier, alert_id uniqueidentifier);
    INSERT INTO @c SELECT TOP (${CRASHING}) id, NEWID() FROM cabinets ORDER BY id;
    INSERT INTO alerts (id, cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
      SELECT alert_id, cabinet_id, '00000000-0000-4000-8000-000000000109', 'major', 'issue:00000000-0000-4000-8000-000000000109', 'System crash', DATEADD(hour, -6, SYSUTCDATETIME()), SYSUTCDATETIME() FROM @c;
    INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail, alert_id)
      SELECT NEWID(), cabinet_id, 'error', DATEADD(hour, -2, SYSUTCDATETIME()), '{"log":"System","source":"BugCheck","eventId":1001,"level":"error","recordId":2}',
             '{"message":"The computer has rebooted from a bugcheck.  The bugcheck was: 0x0000007e (0xffffffffc0000005, 0xfffff8012a4b1c20, 0xffffd50f3a2e7a58, 0xffffd50f3a2e7290)."}', alert_id FROM @c;
    INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail)
      SELECT NEWID(), id, 'change', DATEADD(hour, -5, SYSUTCDATETIME()), '{"log":"Application","source":"MsiInstaller","eventId":11707,"level":"information","recordId":3}',
             '{"message":"Product: Scanner Suite -- Installation completed successfully."}' FROM (SELECT TOP (${CRASHING * 3}) id FROM cabinets ORDER BY id) k;`);
  await owner.end();
  const count = async (t: string) => Number((await db.app.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n);
  console.log(`seeded ${await count("cabinets")} cabinets, ${await count("alerts")} alerts, ${await count("commands")} commands, ${await count("incidents")} incidents, `
    + `${await count("incident_steps")} steps, ${await count("cabinet_drift")} differences, ${await count("events")} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const aClient = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM clients ORDER BY id")).rows[0]!.id;
  const tech = (await db.app.query<{ id: string; username: string; name: string }>("SELECT TOP (1) id, username, name FROM users WHERE username LIKE 'tech.%' ORDER BY id")).rows[0]!;
  const me: SessionUser = { sessionHash: Buffer.alloc(32), stage: "complete", userId: tech.id, username: tech.username, name: tech.name, role: "tier2",
    totpEnabled: true, mustChangePassword: false, tourCompleted: true, canApproveFixes: false };
  const week = { from: new Date(Date.now() - 7 * 86_400_000), to: new Date(Date.now() + 60_000) };
  const key = (await fleetCrashSignatures(db.app, week))[0]?.key;
  if (!key) throw new Error("no crash signature seeded");
  const time = async (what: string, run: () => Promise<unknown>) => {
    await run(); // warm
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) { const s = process.hrtime.bigint(); await run(); ms.push(Number(process.hrtime.bigint() - s) / 1e6); }
    ms.sort((a, b) => a - b);
    console.log(`${what.padEnd(44)} median ${ms[Math.floor(RUNS / 2)]!.toFixed(0).padStart(6)} ms, best ${ms[0]!.toFixed(0)}, worst ${ms[RUNS - 1]!.toFixed(0)}`);
  };
  await time("open incidents", () => openIncidents(db.app, { limit: 100 }));
  await time("open incidents, one client", () => openIncidents(db.app, { clientId: aClient, limit: 100 }));
  await time("fleet differences", () => fleetDifferences(db.app, {}));
  await time("fleet differences, one client", () => fleetDifferences(db.app, { clientId: aClient }));
  await time("fleet differences, one group", () => fleetDifferenceGroup(db.app, { category: "services", itemKey: "Service7", field: "state" }));
  await time("activity report, 8 hours", () => activityReport(db.app, me, { hours: 8 }));
  await time("activity report, 72 hours", () => activityReport(db.app, me, { hours: 72 }));
  await time("crash signatures, 7 days", () => fleetCrashSignatures(db.app, week));
  await time("crash signature report, 7 days", () => crashSignatureReport(db.app, { ...week, key, demo: false }));
} finally {
  await db.drop();
}

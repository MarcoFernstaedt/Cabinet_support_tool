// The console's fleet-wide views at 10,000 cabinets (F21.R4): each view's own service call against a seeded fleet, timed. Not part of
// the suite: run it by hand on a quiet machine, RESOLVED resolved alerts a cabinet (default 20),
//   node dist/test/fleet-views-at-scale.bench.js
import { randomUUID } from "node:crypto";
import * as alerts from "../src/services/alerts.js";
import * as fleet from "../src/services/fleet.js";
import { createPool } from "../src/db/db.js";
import { createTestDatabase } from "./database.js";

const CLIENTS = 20, SITES_PER_CLIENT = 25, CABINETS = 10_000, RESOLVED = Number(process.env.RESOLVED ?? 20), OPEN_EVERY = 5, RUNS = 5;
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
  await owner.end();
  const count = async (t: string) => Number((await db.app.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n);
  console.log(`seeded ${await count("cabinets")} cabinets, ${await count("alerts")} alerts in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
} finally {
  await db.drop();
}

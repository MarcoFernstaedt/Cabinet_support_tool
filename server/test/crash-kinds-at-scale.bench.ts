// The fleet's kinds of blue screen at 10,000 cabinets (F21.R4, decision-log D61): the SQL the console's list ran before (every event of
// every cabinet in the window, filtered on its JSON source) against the SQL it runs now (only the events a blue-screen alert holds,
// through the alerts_issue_recent and events_alert indexes). Not part of the suite: run it by hand on a quiet machine,
//   node dist/test/crash-kinds-at-scale.bench.js
// and it prints the timings, which docs/platform/performance.md records with the machine they were measured on.
import { randomUUID } from "node:crypto";
import { fleetCrashSignatures } from "../src/services/crash-signatures.js";
import { createPool } from "../src/db/db.js";
import { createTestDatabase } from "./database.js";

const CABINETS = 10_000, NOISE_PER_CABINET = 30, CRASHING = 50, RUNS = 5;
const db = await createTestDatabase();
try {
  const clientId = randomUUID(), siteId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Scale')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Scale')", [siteId, clientId]);
  const t0 = Date.now();
  // Seeding 300,000 rows outlasts the pools' 10 s request limit, so the seeding pool has its own.
  const owner = await createPool(db.ownerUrl, { max: 2, requestTimeoutMs: 600_000 });
  {
    await owner.query(`INSERT INTO cabinets (id, site_id, name, role, status)
      SELECT NEWID(), $1, CONCAT('K', n), 'standalone', 'active' FROM (SELECT TOP (${CABINETS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b) x`, [siteId]);
    // The everyday volume: service changes, logged in the last day on every cabinet.
    await owner.query(`INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail)
      SELECT NEWID(), k.id, 'error', DATEADD(second, -n * 2000, SYSUTCDATETIME()), '{"log":"System","source":"Service Control Manager","eventId":7036,"level":"information","recordId":1}', '{"message":"The service entered the running state."}'
        FROM cabinets k CROSS JOIN (SELECT TOP (${NOISE_PER_CABINET}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x`);
    // Blue screens on some of them, each held by the cabinet's blue-screen alert, as the alerts engine links them.
    await owner.query(`DECLARE @c TABLE (cabinet_id uniqueidentifier, alert_id uniqueidentifier);
      INSERT INTO @c SELECT TOP (${CRASHING}) id, NEWID() FROM cabinets ORDER BY id;
      INSERT INTO alerts (id, cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
        SELECT alert_id, cabinet_id, '00000000-0000-4000-8000-000000000109', 'major', 'issue:00000000-0000-4000-8000-000000000109', 'System crash', DATEADD(hour, -6, SYSUTCDATETIME()), SYSUTCDATETIME() FROM @c;
      INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail, alert_id)
        SELECT NEWID(), cabinet_id, 'error', DATEADD(hour, -2, SYSUTCDATETIME()), '{"log":"System","source":"BugCheck","eventId":1001,"level":"error","recordId":2}',
               '{"message":"The computer has rebooted from a bugcheck.  The bugcheck was: 0x0000007e (0xffffffffc0000005, 0xfffff8012a4b1c20, 0xffffd50f3a2e7a58, 0xffffd50f3a2e7290). A dump was saved in: C:\\\\Windows\\\\Minidump\\\\1.dmp."}', alert_id FROM @c;`);
  }
  await owner.end();
  const events = Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM events")).rows[0]!.n);
  console.log(`seeded ${CABINETS} cabinets, ${events} events (${CRASHING} blue screens) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const from = new Date(Date.now() - 2 * 86_400_000), to = new Date(Date.now() + 60_000);
  const ids = (await db.app.query<{ id: string }>("SELECT id FROM cabinets")).rows.map(r => r.id.toLowerCase());
  // The query the list ran before this change, as it was in crash-signatures.ts.
  const before = () => db.app.query(
    `SELECT e.cabinet_id, e.occurred_at, LOWER(JSON_VALUE(e.source, '$.source')) AS src,
            (SELECT j.message FROM OPENJSON(e.detail) WITH (message nvarchar(max) '$.message') j) AS message
       FROM events e
      WHERE e.occurred_at BETWEEN $1 AND $2 AND e.cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($3))
        AND LOWER(JSON_VALUE(e.source, '$.source')) IN ($4, $5) AND TRY_CAST(JSON_VALUE(e.source, '$.eventId') AS int) = 1001
      ORDER BY e.cabinet_id, e.occurred_at`, [from, to, ids, "bugcheck", "microsoft-windows-wer-systemerrorreporting"], { timeoutMs: 120_000 });
  const time = async (what: string, run: () => Promise<unknown>) => {
    await run(); // warm
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) { const s = process.hrtime.bigint(); await run(); ms.push(Number(process.hrtime.bigint() - s) / 1e6); }
    ms.sort((a, b) => a - b);
    console.log(`${what}: median ${ms[Math.floor(RUNS / 2)]!.toFixed(0)} ms, best ${ms[0]!.toFixed(0)} ms, worst ${ms[RUNS - 1]!.toFixed(0)} ms over ${RUNS} runs`);
  };
  await time("before (every event in the window)", before);
  await time("now (the whole list, through the blue-screen alerts)", () => fleetCrashSignatures(db.app, { from, to }));
  const list = await fleetCrashSignatures(db.app, { from, to });
  console.log(`the list: ${list.map(r => `${r.key} on ${r.cabinets} cabinets`).join("; ")}`);
} finally {
  await db.drop();
}

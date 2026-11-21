// "The same error elsewhere" on an event's detail view at 10,000 cabinets (F21.R4, decision-log D138): the statement it ran before (every
// event in the 30-day window, its JSON source opened) against the one it runs now (through events_error_key). Not part of the suite: run
// it by hand on a quiet machine, PER_CABINET events a cabinet (default 200),
//   node dist/test/same-error-at-scale.bench.js
import { randomUUID } from "node:crypto";
import { sameErrorElsewhere } from "../src/services/alerts.js";
import { createPool } from "../src/db/db.js";
import { createTestDatabase } from "./database.js";

const CABINETS = 10_000, PER_CABINET = Number(process.env.PER_CABINET ?? 200), SAME = 50, RUNS = 5;
const db = await createTestDatabase();
try {
  const clientId = randomUUID(), siteId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Scale')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Scale')", [siteId, clientId]);
  const t0 = Date.now();
  // Seeding millions of rows outlasts the pools' 10 s request limit, so the seeding pool has its own.
  const owner = await createPool(db.ownerUrl, { max: 2, requestTimeoutMs: 1_800_000 });
  await owner.query(`INSERT INTO cabinets (id, site_id, name, role, status)
    SELECT NEWID(), $1, CONCAT('K', n), 'standalone', 'active' FROM (SELECT TOP (${CABINETS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b) x`, [siteId]);
  // The everyday volume over the 30 days: errors from 40 sources and 25 event IDs, spread over the window.
  await owner.query(`INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail)
    SELECT NEWID(), k.id, 'error', DATEADD(minute, -(n * 1440 * 30 / ${PER_CABINET}), SYSUTCDATETIME()),
           CONCAT('{"log":"Application","source":"App', n % 40, '","eventId":', 1000 + n % 25, ',"level":"error","recordId":', n, '}'), '{"message":"An application error."}'
      FROM cabinets k CROSS JOIN (SELECT TOP (${PER_CABINET}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b) x`);
  // The error the detail view asks about, on some of them.
  await owner.query(`INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail)
    SELECT TOP (${SAME}) NEWID(), id, 'error', DATEADD(day, -3, SYSUTCDATETIME()), '{"log":"System","source":"Disk","eventId":7,"level":"error","recordId":1}', '{"message":"Bad block."}' FROM cabinets ORDER BY id`);
  const size = (await owner.query<{ mb: number }>(`SELECT SUM(a.used_pages) * 8 / 1024.0 AS mb FROM sys.indexes i JOIN sys.partitions p ON p.object_id = i.object_id AND p.index_id = i.index_id
    JOIN sys.allocation_units a ON a.container_id = p.partition_id WHERE i.object_id = OBJECT_ID('events') AND i.name = 'events_error_key'`)).rows[0]!.mb;
  await owner.end();
  const events = Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM events")).rows[0]!.n);
  console.log(`seeded ${CABINETS} cabinets, ${events} events in ${((Date.now() - t0) / 1000).toFixed(1)} s; events_error_key ${Number(size).toFixed(1)} MB`);
  const one = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM cabinets ORDER BY id")).rows[0]!.id;
  // The count the detail view ran before this change, as it was in alerts.ts.
  const before = () => db.app.query(
    `SELECT COUNT(DISTINCT CASE WHEN cabinet_id <> CAST($1 AS uniqueidentifier) THEN cabinet_id END) AS cabinets, COUNT(*) AS events FROM events e
      WHERE e.kind = 'error' AND e.occurred_at > DATEADD(day, -30, SYSUTCDATETIME()) AND JSON_VALUE(e.source, '$.log') COLLATE Latin1_General_100_BIN2 = $2
        AND JSON_VALUE(e.source, '$.source') = $3 AND JSON_VALUE(e.source, '$.eventId') = $4`, [one, "System", "Disk", "7"], { timeoutMs: 120_000 });
  const time = async (what: string, run: () => Promise<unknown>) => {
    await run(); // warm
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) { const s = process.hrtime.bigint(); await run(); ms.push(Number(process.hrtime.bigint() - s) / 1e6); }
    ms.sort((a, b) => a - b);
    console.log(`${what}: median ${ms[Math.floor(RUNS / 2)]!.toFixed(0)} ms, best ${ms[0]!.toFixed(0)} ms, worst ${ms[RUNS - 1]!.toFixed(0)} ms over ${RUNS} runs`);
  };
  await time("before (every event in the window)", before);
  await time("now (the whole answer, through events_error_key)", () => sameErrorElsewhere(db.app, one, "System", "Disk", 7));
  console.log(`before: ${JSON.stringify((await before()).rows[0])}; now: ${JSON.stringify(await sameErrorElsewhere(db.app, one, "System", "Disk", 7))}`);
} finally {
  await db.drop();
}

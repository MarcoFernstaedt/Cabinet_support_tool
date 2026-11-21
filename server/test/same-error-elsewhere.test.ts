// "The same error elsewhere" on an event's detail view reads the matching events through events_error_key, not every event in the
// 30-day window (F21.R4, decision-log D138): 2 to 4 s against 6 ms at 2 million events. Its answer is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sameErrorElsewhere } from "../src/services/alerts.js";
import { createPool } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function cabinets(n: number): Promise<string[]> {
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  const ids = Array.from({ length: n }, () => randomUUID());
  for (const [i, id] of ids.entries())
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'standalone', 'active')", [id, site, `K${i}`]);
  return ids;
}
const event = (cabinet: string, source: Record<string, unknown>, o: { kind?: string; daysAgo?: number } = {}) => db.app.query(
  `INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail) VALUES ($1, $2, $3, DATEADD(day, -$4, SYSUTCDATETIME()), $5, '{"message":"m"}')`,
  [randomUUID(), cabinet, o.kind ?? "error", o.daysAgo ?? 1, JSON.stringify({ level: "error", recordId: 1, ...source })]);

test("the answer counts the same log, source and event ID on other cabinets in the last 30 days, and nothing else", async () => {
  const [me, a, b, c] = await cabinets(4);
  const same = { log: "System", source: "Disk", eventId: 7 };
  await event(me!, same); await event(a!, same); await event(a!, same); await event(b!, { ...same, source: "disk" }); // the source matches without case, as before
  await event(c!, { ...same, eventId: 8 });                 // another event ID
  await event(c!, { ...same, source: "Disk2" });            // another source
  await event(c!, { ...same, log: "system" });              // the log matches exactly, as before
  await event(c!, same, { kind: "warning" });               // not an error
  await event(c!, same, { daysAgo: 31 });                   // outside the window
  assert.deepEqual(await sameErrorElsewhere(db.app, me!, "System", "Disk", 7), { otherCabinets: 2, events: 4, issueName: null, days: 30 });
});

test("both statements seek events_error_key rather than read every event in the window", async () => {
  const [me] = await cabinets(1);
  await event(me!, { log: "System", source: "Disk", eventId: 7 });
  await sameErrorElsewhere(db.app, me!, "System", "Disk", 7);
  // The plans SQL Server cached for the two statements of this database, read as its owner (the server's plan cache).
  const name = (await db.app.query<{ n: string }>("SELECT DB_NAME() AS n")).rows[0]!.n;
  const owner = await createPool(db.ownerUrl, { max: 1 });
  try {
    for (const fragment of ["COUNT(DISTINCT CASE WHEN cabinet_id <>", "SELECT TOP (1) t.name FROM events e"]) {
      const plans = (await owner.query<{ p: string }>(
        `SELECT CAST(qp.query_plan AS nvarchar(max)) AS p FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
           CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
          WHERE CHARINDEX($1, st.text) > 0 AND CHARINDEX($2, CAST(qp.query_plan AS nvarchar(max))) > 0`, [fragment, `[${name}]`])).rows.map(r => r.p);
      assert.ok(plans.length > 0, `a cached plan for "${fragment}"`);
      for (const p of plans) assert.match(p, /PhysicalOp="Index Seek"[^]*?Index="\[events_error_key\]"/, `an index seek on events_error_key for "${fragment}"`);
    }
  } finally {
    await owner.end();
  }
});

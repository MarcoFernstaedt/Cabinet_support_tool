// The fleet crash incident reads its crashes and the changes it compares through events_error_key, one seek per key, instead of
// opening the JSON source of every event in the window (F21.R4, decision-log D153): 68 s and past the 10 s statement limit against
// 266 ms at 10,000 cabinets. Its answer is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fleetCrashIncident } from "../src/services/crashes.js";
import { createPool } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function client(n: number): Promise<{ client: string; ids: string[] }> {
  const c = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [c, `C ${c.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, c]);
  const ids = Array.from({ length: n }, () => randomUUID());
  for (const [i, id] of ids.entries())
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'standalone', 'active')", [id, site, `K${i}`]);
  return { client: c, ids };
}
const event = (cabinet: string, kind: string, source: Record<string, unknown>, message: string, hoursAgo: number) => db.app.query(
  `INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail) VALUES ($1, $2, $3, DATEADD(hour, -$4, SYSUTCDATETIME()), $5, $6)`,
  [randomUUID(), cabinet, kind, hoursAgo, JSON.stringify({ log: "System", level: "error", recordId: 1, ...source }), JSON.stringify({ message })]);
const bugcheck = (cabinet: string, source = "BugCheck") =>
  event(cabinet, "error", { source, eventId: 1001 }, "The computer has rebooted from a bugcheck.  The bugcheck was: 0x0000007e (0x1, 0x2, 0x3, 0x4).", 2);
const installed = (cabinet: string) => event(cabinet, "change", { source: "MsiInstaller", eventId: 11707 }, "Product: Scanner Suite -- Installation completed successfully.", 5);
const window = () => ({ from: new Date(Date.now() - 3 * 86_400_000), to: new Date(Date.now() + 60_000) });

test("the incident counts crashes whatever the source's case, only in its scope, and still compares what changed before them", async () => {
  const mine = await client(3), other = await client(1);
  await bugcheck(mine.ids[0]!); await bugcheck(mine.ids[1]!, "BUGCHECK");
  await installed(mine.ids[0]!); await installed(mine.ids[1]!);
  await event(mine.ids[2]!, "error", { source: "BugCheck", eventId: 1002 }, "another event ID", 2);   // not a crash key
  await bugcheck(other.ids[0]!);                                                                      // another client
  const inc = await fleetCrashIncident(db.app, { ...window(), clientId: mine.client });
  assert.equal(inc.cabinets, 3);
  assert.deepEqual(inc.cabinetsAffected.map(r => r.crashes).sort(), [1, 1]);
  assert.deepEqual(inc.stopCodes.map(s => [s.stopCode.text, s.cabinets]), [["0x0000007E", 2]]);
  const change = inc.comparisons.find(c => c.change.startsWith("Software installed"));
  assert.ok(change, JSON.stringify(inc.comparisons.map(c => c.change)));
  assert.deepEqual([change.affected, change.unaffected, change.standsOut], [2, 0, true]);
  assert.equal((await fleetCrashIncident(db.app, window())).affected, 3, "the whole fleet holds the other client's crash too");
});

test("both event statements seek events_error_key, with no scan of it", async () => {
  const { ids } = await client(2);
  await bugcheck(ids[0]!); await installed(ids[0]!);
  await fleetCrashIncident(db.app, window());
  // The plans SQL Server cached for this database, read as its owner (the server's plan cache).
  const name = (await db.app.query<{ n: string }>("SELECT DB_NAME() AS n")).rows[0]!.n;
  const owner = await createPool(db.ownerUrl, { max: 1 });
  try {
    for (const fragment of ["JSON_QUERY(e.detail, '$.fields') AS fields_json", "SELECT DISTINCT TOP (100000) e.cabinet_id"]) {
      const plans = (await owner.query<{ p: string }>(
        `SELECT CAST(qp.query_plan AS nvarchar(max)) AS p FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
           CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
          WHERE CHARINDEX($1, st.text) > 0 AND CHARINDEX($2, CAST(qp.query_plan AS nvarchar(max))) > 0`, [fragment, `[${name}]`])).rows.map(r => r.p);
      assert.ok(plans.length > 0, `a cached plan for "${fragment}"`);
      // An operator's own object, named before the operator ends or the next one starts.
      const on = (op: string, object: string) => new RegExp(`PhysicalOp="${op}"(?:(?!<\\/?RelOp)[^])*?<Object [^>]*${object}`);
      for (const p of plans) {
        assert.match(p, on("Index Seek", 'Index="\\[events_error_key\\]"'), `an index seek on events_error_key for "${fragment}"`);
        assert.doesNotMatch(p, on("Index Scan", 'Table="\\[events\\]"'), `no index scan of events for "${fragment}"`);
        assert.doesNotMatch(p, on("Clustered Index Scan", 'Table="\\[events\\]"'), `no scan of events for "${fragment}"`);
      }
    }
  } finally {
    await owner.end();
  }
});

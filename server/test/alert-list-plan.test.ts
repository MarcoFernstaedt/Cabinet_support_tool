// The alert list reads its page through an index instead of every alert (F21.R4, decision-log D140): each list is one statement with
// only the filters given, ordered by severity and last seen as alerts_state_severity holds them. At 10,000 cabinets with 200,000 resolved
// alerts the resolved list went from 3,435 ms to 11 ms. The order is unchanged: major before minor, then the newest first.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { listAlerts } from "../src/services/alerts.js";
import { createPool } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function place(cabinets: number): Promise<{ client: string; site: string }> {
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status)
    SELECT NEWID(), $1, CONCAT('K', n), 'standalone', 'active' FROM (SELECT TOP (${cabinets}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x`, [site]);
  return { client, site };
}

test("the list keeps its order: major before minor, then the newest first, active or resolved, and with a filter", async () => {
  const { client, site } = await place(1);
  const cabinet = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE site_id = $1", [site])).rows[0]!.id;
  const add = (title: string, severity: string, state: string, minutesAgo: number) => db.app.query(
    "INSERT INTO alerts (cabinet_id, severity, signature, title, state, first_seen, last_seen) VALUES ($1, $2, $3, $3, $4, DATEADD(minute, -$5, SYSUTCDATETIME()), DATEADD(minute, -$5, SYSUTCDATETIME()))",
    [cabinet, severity, title, state, minutesAgo]);
  await add("minor new", "minor", "open", 1); await add("major old", "major", "claimed", 30); await add("major new", "major", "open", 2);
  await add("minor old", "minor", "claimed", 40); await add("gone major", "major", "resolved", 5); await add("gone minor", "minor", "resolved", 3);
  const titles = async (f: Record<string, string>) => (await listAlerts(db.app, { clientId: client, ...f } as never, randomUUID())).map(a => a.title);
  assert.deepEqual(await titles({}), ["major new", "major old", "minor new", "minor old"]);
  assert.deepEqual(await titles({ state: "resolved" }), ["gone major", "gone minor"]);
  assert.deepEqual(await titles({ severity: "minor" }), ["minor new", "minor old"]);
  assert.deepEqual(await titles({ state: "claimed" }), ["major old", "minor old"]);
});

test("the resolved list reads its page, not every resolved alert", async () => {
  await place(200);
  // 100,000 resolved alerts: through alerts_state_severity the list read 4,798 pages, and every one of them 11,669.
  const owner = await createPool(db.ownerUrl, { max: 1, requestTimeoutMs: 300_000 });
  try {
    await owner.query(`INSERT INTO alerts (cabinet_id, severity, signature, title, state, first_seen, last_seen)
      SELECT k.id, CASE WHEN n % 3 = 0 THEN 'major' ELSE 'minor' END, CONCAT('s', n), 't', 'resolved', DATEADD(minute, -n, SYSUTCDATETIME()), DATEADD(minute, -n, SYSUTCDATETIME())
        FROM cabinets k CROSS JOIN (SELECT TOP (500) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x WHERE k.name LIKE 'K%'`);
    assert.equal((await listAlerts(db.app, { state: "resolved" } as never, randomUUID())).length, 500);
    const name = (await db.app.query<{ n: string }>("SELECT DB_NAME() AS n")).rows[0]!.n;
    const reads = (await owner.query<{ reads: number }>(
      `SELECT qs.last_logical_reads AS reads FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
         CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
        WHERE CHARINDEX('FETCH NEXT 500 ROWS ONLY', st.text) > 0 AND CHARINDEX($1, CAST(qp.query_plan AS nvarchar(max))) > 0`, [`[${name}]`])).rows.map(r => Number(r.reads));
    assert.ok(reads.length > 0, "the list's statement is in the plan cache");
    for (const r of reads) assert.ok(r < 8_000, `${r} pages read for one page of 500 alerts`);
  } finally {
    await owner.end();
  }
});

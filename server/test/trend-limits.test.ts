// The limit kept on screen (F17): the trends answer says how many rows matched against how many it lists, and which days kept only the
// busiest groups, so a cut list is never read as the whole. On a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ERROR_TREND_LIMIT, MAX_GROUPS_PER_DAY, errorTrends } from "../src/services/error-trends.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let clientId: string;
const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;
const day = (ago: number) => new Date(today - ago * DAY);

test.before(async () => {
  db = await createTestDatabase();
  clientId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("UPDATE trend_state SET computed_through = $1, computed_at = SYSUTCDATETIME() WHERE id = 1", [day(1)]);
});
test.after(async () => { await db.drop(); });

test("more errors than the list holds: the answer says the 200 shown are of 205 matched", async () => {
  // 205 different errors yesterday.
  await db.app.query(`INSERT INTO error_daily ([day], client_id, [log], [source], event_id, issue_type_id, cabinets, [events], [sample])
    SELECT $1, $2, 'System', CONCAT('Source', n), 1000 + n, NULL, 1, 3, NULL
      FROM (SELECT TOP (205) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x`, [day(1), clientId]);
  const r = await errorTrends(db.app, {} as never) as unknown as { errors: unknown[]; limits: { errors: { shown: number; matched: number; limit: number }; daysAtGroupLimit: string[] } };
  assert.equal(r.errors.length, ERROR_TREND_LIMIT);
  assert.deepEqual(r.limits.errors, { shown: 200, matched: 205, limit: 200 });
  assert.deepEqual(r.limits.daysAtGroupLimit, [], "no day reached the per-day limit");
});

test("a day that kept only the busiest groups is named", async () => {
  await db.app.query(`INSERT INTO error_daily ([day], client_id, [log], [source], event_id, issue_type_id, cabinets, [events], [sample])
    SELECT $1, $2, 'Application', CONCAT('Flood', n), n, NULL, 1, 1, NULL
      FROM (SELECT TOP (${MAX_GROUPS_PER_DAY}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b) x`, [day(2), clientId]);
  const r = await errorTrends(db.app, {} as never) as unknown as { limits: { daysAtGroupLimit: string[] } };
  assert.deepEqual(r.limits.daysAtGroupLimit, [day(2).toISOString().slice(0, 10)]);
});

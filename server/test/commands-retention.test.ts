// Old command results and firewall history are cleared and removed by commands.ts, their owner (F21.R2, decision-log D72): only what is
// older than the cut-off, each batch audited; the command itself stays; a cut-off that is not a past time is refused; a repeat does nothing more.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { clearOldCommandResults, pruneFirewallChanges } from "../src/services/commands.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
const user = randomUUID(), cabinet = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'keep.cmd', 'Keep', 'tier1')", [user]);
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Retain')", [client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [cabinet, site]);
});
test.after(async () => { await db?.drop(); });
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const batches = async (table: string) => (await db.app.query<{ details: { rows: number } }>(
  "SELECT details FROM audit_log WHERE action = 'retention.batch' AND JSON_VALUE(details, '$.table') = $1", [table])).rows.map(r => r.details.rows);

test("old command results are cleared with their search text; the commands themselves, and newer results, stay", async () => {
  const command = async (age: number) => {
    const id = randomUUID();
    await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at, search_text)
                        VALUES ($1, $2, 'software.list', '{}', $3, $4, DATEADD(minute, 5, $4), 'succeeded', '{"x":1}', $4, 'old program')`, [id, cabinet, user, daysAgo(age)]);
    return id;
  };
  const [old1, old2, recent] = [await command(100), await command(95), await command(10)];
  assert.equal(await clearOldCommandResults(db.app, daysAgo(90)), 2);
  const rows = new Map((await db.app.query<{ id: string; result: unknown; search_text: string | null }>("SELECT id, result, search_text FROM commands WHERE cabinet_id = $1", [cabinet])).rows
    .map(r => [r.id.toLowerCase(), [r.result === null, r.search_text === null]]));
  assert.deepEqual([rows.get(old1), rows.get(old2), rows.get(recent)], [[true, true], [true, true], [false, false]], "both cleared on the old ones; the recent one whole; all three commands still there");
  assert.equal(await clearOldCommandResults(db.app, daysAgo(90)), 0);
  assert.deepEqual(await batches("commands.result"), [2]);
});

test("old firewall history goes; newer stays; a repeat removes nothing", async () => {
  for (const age of [400, 370, 30]) await db.app.query("INSERT INTO firewall_changes (cabinet_id, explained, occurred_at) VALUES ($1, 0, $2)", [cabinet, daysAgo(age)]);
  assert.equal(await pruneFirewallChanges(db.app, daysAgo(365)), 2);
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM firewall_changes WHERE cabinet_id = $1", [cabinet])).rows[0]!.n), 1);
  assert.equal(await pruneFirewallChanges(db.app, daysAgo(365)), 0);
  assert.deepEqual(await batches("firewall_changes"), [2]);
});

test("a cut-off that is not a time already passed is refused before anything is changed", async () => {
  await db.app.query("INSERT INTO firewall_changes (cabinet_id, explained, occurred_at) VALUES ($1, 0, $2)", [cabinet, daysAgo(1000)]);
  for (const bad of [new Date(Date.now() + 60_000), new Date("nope"), "2020-01-01", 0, null]) {
    await assert.rejects(clearOldCommandResults(db.app, bad as never), /retention cut-off/, String(bad));
    await assert.rejects(pruneFirewallChanges(db.app, bad as never), /retention cut-off/, String(bad));
  }
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM firewall_changes WHERE occurred_at < $1", [daysAgo(999)])).rows[0]!.n), 1);
});

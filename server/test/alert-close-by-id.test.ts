// The close of a regrouped alert by its id, moved from rules.ts into alerts.ts, the table's owner (F21.R2, decision-log D95). It closes
// that one alert, audits the close as alert.resolve, and checks what it is given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeAlertById } from "../src/services/alerts.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function cabinet(): Promise<string> {
  const client = randomUUID(), site = randomUUID(), k = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [k, site]);
  return k;
}
async function alert(k: string): Promise<string> {
  return (await db.app.query<{ id: string }>(`DECLARE @o TABLE (id uniqueidentifier);
    INSERT INTO alerts (cabinet_id, severity, signature, title, first_seen, last_seen) OUTPUT inserted.id INTO @o
    VALUES ($1, 'minor', $2, 'T', SYSUTCDATETIME(), SYSUTCDATETIME()); SELECT id FROM @o;`, [k, `unrecognized:${randomUUID()}`])).rows[0]!.id.toLowerCase();
}
const row = async (id: string) => (await db.app.query<{ state: string; resolution: string | null }>("SELECT state, resolution FROM alerts WHERE id = $1", [id])).rows[0]!;
const audits = async (ids: string[]) => (await db.app.query<{ target_id: string; actor_kind: string; actor_id: string; details: Record<string, unknown> }>(
  "SELECT target_id, actor_kind, actor_id, details FROM audit_log WHERE action = 'alert.resolve' AND target_id IN (SELECT value FROM OPENJSON($1))", [JSON.stringify(ids)])).rows;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("closes that one alert with the resolution, audited once by the closer, and no other alert of the cabinet", async () => {
  const k = await cabinet(), id = await alert(k), other = await alert(k);
  const closed = await closeAlertById(db.app, "rule-regroup", id, "Regrouped under Scanner disconnected.");
  assert.deepEqual(closed.map(c => c.id.toLowerCase()), [id]);
  assert.deepEqual(await row(id), { state: "resolved", resolution: "Regrouped under Scanner disconnected." });
  assert.equal((await row(other)).state, "open");
  const rows = await audits([id, other]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.target_id, id); assert.equal(rows[0]!.actor_kind, "system"); assert.equal(rows[0]!.actor_id, "rule-regroup");
  assert.equal(rows[0]!.details.automatic, true); assert.equal(rows[0]!.details.cabinetId, k.toLowerCase());
  assert.equal(rows[0]!.details.resolution, "Regrouped under Scanner disconnected.");
  assert.deepEqual(await closeAlertById(db.app, "rule-regroup", randomUUID(), "Regrouped under X."), [], "an unknown id closes nothing");
});

test("a close in a transaction that rolls back leaves the alert open and unaudited", async () => {
  const k = await cabinet(), id = await alert(k);
  await assert.rejects(db.app.transaction(async tx => {
    await closeAlertById(tx, "rule-regroup", id, "Regrouped under Scanner disconnected.");
    throw new Error("rolled back");
  }), /rolled back/);
  assert.equal((await row(id)).state, "open");
  assert.equal((await audits([id])).length, 0);
});

test("anything but a closer name, an alert id and a plain resolution is refused before the database is touched", async () => {
  const k = await cabinet(), id = await alert(k);
  const cases: unknown[][] = [];
  for (const by of [undefined, null, "", "Rule", "-x", "a b", "a".repeat(65), 7]) cases.push([by, id, "Gone."]);
  for (const v of [undefined, null, "", "not-an-id", `${id}'; DROP TABLE alerts; --`, 42]) cases.push(["rule-regroup", v, "Gone."]);
  for (const r of [undefined, null, "", "   ", "a".repeat(501), "line\nfeed", "nul\u0000", 3]) cases.push(["rule-regroup", id, r]);
  for (const [by, alertId, res] of cases)
    await assert.rejects(closeAlertById(untouched, by as never, alertId as never, res as never), (e: Error) => !/reached the database/.test(e.message), JSON.stringify([by, alertId, res]));
  assert.equal(cases.length, 22);
  assert.equal((await row(id)).state, "open", "nothing was closed");
});

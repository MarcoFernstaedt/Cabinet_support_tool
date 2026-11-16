// The move of a regrouped alert's events, from rules.ts into events.ts, the table's owner (F21.R2, decision-log D104). Every event of
// the alert moved from goes to the alert moved to, with the rule that matched it; no other event changes. What it is given is checked
// before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { moveAlertEvents } from "../src/services/events.js";
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
    VALUES ($1, 'minor', $2, 'T', SYSUTCDATETIME(), SYSUTCDATETIME()); SELECT id FROM @o;`, [k, `move-test:${randomUUID()}`])).rows[0]!.id.toLowerCase();
}
async function event(k: string, alertId: string | null, rule: string | null = null): Promise<string> {
  const id = randomUUID();
  await db.app.query("INSERT INTO events (event_id, cabinet_id, kind, occurred_at, alert_id, matched_rule) VALUES ($1, $2, 'eventlog', SYSUTCDATETIME(), $3, $4)", [id, k, alertId, rule]);
  return id;
}
const of = async (id: string) => (await db.app.query<{ alert_id: string | null; matched_rule: string | null }>(
  "SELECT LOWER(CONVERT(nvarchar(64), alert_id)) AS alert_id, LOWER(CONVERT(nvarchar(64), matched_rule)) AS matched_rule FROM events WHERE event_id = $1", [id])).rows[0]!;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("every event of the alert moved from goes to the alert moved to, with the rule, and no other event changes", async () => {
  const k = await cabinet();
  const from = await alert(k), to = await alert(k), other = await alert(k);
  const rule = randomUUID(), earlierRule = randomUUID();
  const moving = [await event(k, from), await event(k, from, earlierRule)];
  const already = await event(k, to, earlierRule), elsewhere = await event(k, other), loose = await event(k, null);
  assert.equal(await moveAlertEvents(db.app, from, to, rule), 2);
  for (const id of moving) assert.deepEqual(await of(id), { alert_id: to, matched_rule: rule });
  assert.deepEqual(await of(already), { alert_id: to, matched_rule: earlierRule }, "an event already on the target keeps its rule");
  assert.deepEqual(await of(elsewhere), { alert_id: other, matched_rule: null });
  assert.deepEqual(await of(loose), { alert_id: null, matched_rule: null });
  // Nothing is left on the alert moved from, so a repeat moves nothing.
  assert.equal(await moveAlertEvents(db.app, from, to, rule), 0);
});

test("a move in a transaction that rolls back leaves the events where they were", async () => {
  const k = await cabinet();
  const from = await alert(k), to = await alert(k);
  const id = await event(k, from);
  await assert.rejects(db.app.transaction(async tx => {
    assert.equal(await moveAlertEvents(tx, from, to, randomUUID()), 1);
    throw new Error("rolled back");
  }), /rolled back/);
  assert.deepEqual(await of(id), { alert_id: from, matched_rule: null });
});

test("anything but three uuids, two alerts that differ, is refused before the database is touched", async () => {
  const a = randomUUID(), b = randomUUID(), r = randomUUID();
  const bad = [undefined, null, "", "not-an-id", `${a}'; DROP TABLE events; --`, 42, [a]];
  let refused = 0;
  const refuse = async (p: Promise<unknown>, why: RegExp, what: string) => {
    await assert.rejects(p, (e: Error) => why.test(e.message), what); refused++;
  };
  for (const v of bad) await refuse(moveAlertEvents(untouched, v as never, b, r), /alert to move from must be a uuid/, `from ${String(v)}`);
  for (const v of bad) await refuse(moveAlertEvents(untouched, a, v as never, r), /alert to move to must be a uuid/, `to ${String(v)}`);
  for (const v of bad) await refuse(moveAlertEvents(untouched, a, b, v as never), /rule must be a uuid/, `rule ${String(v)}`);
  await refuse(moveAlertEvents(untouched, a, a.toUpperCase(), r), /not moved onto the same alert/, "the same alert in other letter case");
  assert.equal(refused, 22);
});

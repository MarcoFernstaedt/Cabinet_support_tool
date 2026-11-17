// Recording which alert and rule each event of a batch got, moved from alerts.ts into events.ts, the table's owner (F21.R2, decision-log
// D112). alerts.ts processBatch decides the links; linkEventsToAlerts writes them for one cabinet's events only, and checks what it is
// given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { linkEventsToAlerts } from "../src/services/events.js";
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
    VALUES ($1, 'minor', $2, 'T', SYSUTCDATETIME(), SYSUTCDATETIME()); SELECT id FROM @o;`, [k, `link-test:${randomUUID()}`])).rows[0]!.id.toLowerCase();
}
async function event(k: string): Promise<string> {
  const id = randomUUID();
  await db.app.query("INSERT INTO events (event_id, cabinet_id, kind, occurred_at) VALUES ($1, $2, 'eventlog', SYSUTCDATETIME())", [id, k]);
  return id;
}
const of = async (id: string) => (await db.app.query<{ alert_id: string | null; matched_rule: string | null }>(
  "SELECT LOWER(CONVERT(nvarchar(64), alert_id)) AS alert_id, LOWER(CONVERT(nvarchar(64), matched_rule)) AS matched_rule FROM events WHERE event_id = $1", [id])).rows[0]!;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("each event learns its alert and rule; an event of another cabinet, or not named, is not touched", async () => {
  const k = await cabinet(), other = await cabinet();
  const a = await alert(k), b = await alert(other);
  const rule = randomUUID();
  const raised = await event(k), suppressed = await event(k), resolved = await event(k), untouchedEvent = await event(k), foreign = await event(other);
  const n = await linkEventsToAlerts(db.app, k, [
    { e: raised, a, r: rule }, { e: suppressed, a: null, r: rule }, { e: resolved, a, r: null },
    // Another cabinet's event, named under this cabinet: never written.
    { e: foreign, a: b, r: rule },
  ]);
  assert.equal(n, 3);
  assert.deepEqual(await of(raised), { alert_id: a, matched_rule: rule });
  assert.deepEqual(await of(suppressed), { alert_id: null, matched_rule: rule });
  assert.deepEqual(await of(resolved), { alert_id: a, matched_rule: null });
  assert.deepEqual(await of(untouchedEvent), { alert_id: null, matched_rule: null });
  assert.deepEqual(await of(foreign), { alert_id: null, matched_rule: null }, "another cabinet's event is not this cabinet's to link");
  assert.equal(await linkEventsToAlerts(untouched, k, []), 0, "an empty list writes nothing");
});

test("a link in a transaction that rolls back leaves the event as it was", async () => {
  const k = await cabinet();
  const a = await alert(k), id = await event(k);
  await assert.rejects(db.app.transaction(async tx => {
    assert.equal(await linkEventsToAlerts(tx, k, [{ e: id, a, r: null }]), 1);
    throw new Error("rolled back");
  }), /rolled back/);
  assert.deepEqual(await of(id), { alert_id: null, matched_rule: null });
});

test("what it is given is checked before the database is touched, each refusal with its own reason", async () => {
  const k = randomUUID(), e = randomUUID(), a = randomUUID();
  const cases: [string, unknown, unknown, RegExp][] = [
    ["no cabinet", undefined, [], /the cabinet must be a uuid/],
    ["a cabinet that is not a uuid", "1' OR '1'='1", [], /the cabinet must be a uuid/],
    ["a cabinet that is a number", 7, [], /the cabinet must be a uuid/],
    ["links that are not a list", k, { e, a, r: null }, /the links are a list/],
    ["links that are text", k, "[]", /the links are a list/],
    ["more links than a batch holds", k, Array.from({ length: 101 }, () => ({ e: randomUUID(), a, r: null })), /at most 100 links/],
    ["a link that is null", k, [null], /a link is an event, its alert and its rule/],
    ["a link that is a list", k, [[e, a, null]], /a link is an event, its alert and its rule/],
    ["an event that is not a uuid", k, [{ e: "x'; DROP TABLE events; --", a, r: null }], /a link's event must be a uuid/],
    ["no event", k, [{ a, r: null }], /a link's event must be a uuid/],
    ["an alert that is not a uuid", k, [{ e, a: "not-an-alert", r: null }], /a link's alert must be a uuid or null/],
    ["an alert that is a number", k, [{ e, a: 1, r: null }], /a link's alert must be a uuid or null/],
    ["an alert left out", k, [{ e, r: null }], /a link's alert must be a uuid or null/],
    ["a rule that is not a uuid", k, [{ e, a, r: "rule" }], /a link's rule must be a uuid or null/],
    ["a rule left out", k, [{ e, a }], /a link's rule must be a uuid or null/],
    ["neither alert nor rule", k, [{ e, a: null, r: null }], /a link names an alert, a rule or both/],
    ["one event twice", k, [{ e, a, r: null }, { e: e.toUpperCase(), a: null, r: randomUUID() }], /an event is linked once/],
  ];
  for (const [name, cabinetId, links, reason] of cases)
    await assert.rejects(linkEventsToAlerts(untouched, cabinetId as string, links as never), reason, name);
  assert.equal(cases.length, 17);
});

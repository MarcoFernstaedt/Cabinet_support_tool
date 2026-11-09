// Event and alert retention run by their owners (F21.R2, decision-log D75): old events go; events lose the link to an old resolved alert;
// the alert then goes, once nothing points at it; an open alert never goes. Each refuses a cut-off that is not a past time, and a repeat
// changes nothing more.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pruneOldEvents, unlinkEventsOfOldAlerts } from "../src/services/events.js";
import { pruneResolvedAlerts } from "../src/services/alerts.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
const cabinet = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Events')", [client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [cabinet, site]);
});
test.after(async () => { await db?.drop(); });
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
async function alert(state: "open" | "resolved", age: number): Promise<string> {
  const id = randomUUID();
  await db.app.query(`INSERT INTO alerts (id, cabinet_id, severity, signature, title, first_seen, last_seen, state, resolved_at)
                      VALUES ($1, $2, 'minor', $3, 'Test alert', $4, $4, $5, $6)`, [id, cabinet, `test:${id}`, daysAgo(age), state, state === "resolved" ? daysAgo(age) : null]);
  return id;
}
async function event(age: number, alertId: string | null = null): Promise<string> {
  const id = randomUUID();
  await db.app.query("INSERT INTO events (event_id, cabinet_id, kind, occurred_at, received_at, detail, alert_id) VALUES ($1, $2, 'error', $3, $3, '{}', $4)",
    [id, cabinet, daysAgo(age), alertId]);
  return id;
}
const exists = async (table: "alerts" | "events", id: string) =>
  (await db.app.query(`SELECT 1 AS x FROM ${table} WHERE ${table === "alerts" ? "id" : "event_id"} = $1`, [id])).rows.length === 1;
const linkOf = async (eventId: string) => (await db.app.query<{ a: string | null }>("SELECT alert_id AS a FROM events WHERE event_id = $1", [eventId])).rows[0]?.a ?? null;

test("old events go and recent ones stay; a repeat removes nothing", async () => {
  const [old, recent] = [await event(120), await event(5)];
  assert.ok(await pruneOldEvents(db.app, daysAgo(90)) >= 1);
  assert.deepEqual([await exists("events", old), await exists("events", recent)], [false, true]);
  assert.equal(await pruneOldEvents(db.app, daysAgo(90)), 0);
});

test("a resolved alert goes only once no event points at it; the event stays, unlinked; an open alert never goes", async () => {
  const [old, open, recentResolved] = [await alert("resolved", 400), await alert("open", 900), await alert("resolved", 10)];
  const kept = await event(20, old);
  const openEvent = await event(20, open);
  assert.equal(await pruneResolvedAlerts(db.app, daysAgo(365)), 0, "the old alert still has an event pointing at it");
  assert.ok(await exists("alerts", old));
  assert.equal(await unlinkEventsOfOldAlerts(db.app, daysAgo(365)), 1);
  assert.equal(await linkOf(kept), null, "the event stays and loses the link");
  assert.equal((await linkOf(openEvent))?.toLowerCase(), open.toLowerCase(), "an open alert's events keep theirs");
  assert.equal(await unlinkEventsOfOldAlerts(db.app, daysAgo(365)), 0);
  assert.equal(await pruneResolvedAlerts(db.app, daysAgo(365)), 1);
  assert.deepEqual([await exists("alerts", old), await exists("alerts", open), await exists("alerts", recentResolved), await exists("events", kept)], [false, true, true, true]);
  assert.equal(await pruneResolvedAlerts(db.app, daysAgo(365)), 0);
});

test("a cut-off that is not a time already passed is refused by each, before anything changes", async () => {
  const old = await event(2000);
  for (const prune of [pruneOldEvents, unlinkEventsOfOldAlerts, pruneResolvedAlerts])
    for (const bad of [new Date(Date.now() + 60_000), new Date("x"), "2020-01-01", 0, null])
      await assert.rejects(prune(db.app, bad as never), /retention cut-off/, `${prune.name}: ${String(bad)}`);
  assert.ok(await exists("events", old));
});

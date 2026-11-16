// The site-outage close that site-outage.ts made itself, moved into alerts.ts, the table's owner (F21.R2, decision-log D99). It closes only
// the alerts it is given, only where the alert's site has an active cabinet heard from within the window, checked in the statement itself,
// and audits each close as alert.resolve. What it is given is checked before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SITE_OUTAGE_CLOSE_SLICE, closeSiteOutageAlerts } from "../src/services/alerts.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

const WINDOW = 300;
const RESOLUTION = "A cabinet at the site is reporting again.";

/** A site with one cabinet per entry: how many seconds ago it was heard from (null: never), and its status. */
async function site(cabinets: { agoSeconds: number | null; status?: "active" | "removed" }[]): Promise<string[]> {
  const client = randomUUID(), s = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [s, client]);
  const ids: string[] = [];
  for (const c of cabinets) {
    const k = randomUUID();
    await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at)
      VALUES ($1, $2, $5, 'standalone', $3, CASE WHEN $4 IS NULL THEN NULL ELSE DATEADD(second, -CAST($4 AS int), SYSUTCDATETIME()) END)`,
      [k, s, c.status ?? "active", c.agoSeconds, `K${ids.length + 1}`]);
    ids.push(k);
  }
  return ids;
}
// Each alert its own signature: a cabinet holds one unresolved alert per signature, and some cabinets here hold two.
async function alert(k: string, state: "open" | "claimed" | "resolved" = "open"): Promise<string> {
  return (await db.app.query<{ id: string }>(`DECLARE @o TABLE (id uniqueidentifier);
    INSERT INTO alerts (cabinet_id, severity, signature, title, first_seen, last_seen, state) OUTPUT inserted.id INTO @o
    VALUES ($1, 'major', $3, 'Site outage', SYSUTCDATETIME(), SYSUTCDATETIME(), $2); SELECT id FROM @o;`, [k, state, `site-outage-test:${randomUUID()}`])).rows[0]!.id.toLowerCase();
}
const row = async (id: string) => (await db.app.query<{ state: string; resolution: string | null }>("SELECT state, resolution FROM alerts WHERE id = $1", [id])).rows[0]!;
const audits = async (ids: string[]) => (await db.app.query<{ target_id: string; actor_kind: string; actor_id: string; details: Record<string, unknown> }>(
  "SELECT target_id, actor_kind, actor_id, details FROM audit_log WHERE action = 'alert.resolve' AND target_id IN (SELECT value FROM OPENJSON($1))", [JSON.stringify(ids)])).rows;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a close resolves the given alerts at live sites, audited once each by the closer, and nothing else", async () => {
  const [liveDown, liveUp] = await site([{ agoSeconds: 3_600 }, { agoSeconds: 10 }]);
  const [deadA] = await site([{ agoSeconds: 3_600 }, { agoSeconds: 1_800 }]);
  const [removedOnly] = await site([{ agoSeconds: 3_600 }, { agoSeconds: 10, status: "removed" }]);
  const open = await alert(liveDown!), claimed = await alert(liveUp!, "claimed"), dead = await alert(deadA!);
  const removed = await alert(removedOnly!), notGiven = await alert(liveDown!), done = await alert(liveUp!, "resolved");
  const closed = await closeSiteOutageAlerts(db.app, "site-outage", [open, claimed, dead, removed, done], WINDOW, RESOLUTION);
  assert.deepEqual(closed.map(c => c.id.toLowerCase()).sort(), [open, claimed].sort());
  for (const id of [open, claimed]) assert.deepEqual(await row(id), { state: "resolved", resolution: RESOLUTION });
  assert.equal((await row(dead)).state, "open", "a site no cabinet of which was heard from in the window stays down");
  assert.equal((await row(removed)).state, "open", "a removed cabinet reporting does not make its site live");
  assert.equal((await row(notGiven)).state, "open", "an alert not given is not closed");
  assert.equal((await row(done)).resolution, null, "an alert resolved already is not rewritten");
  const rows = await audits([open, claimed, dead, removed, notGiven, done]);
  assert.deepEqual(rows.map(r => r.target_id).sort(), [open, claimed].sort());
  for (const r of rows) {
    assert.equal(r.actor_kind, "system"); assert.equal(r.actor_id, "site-outage");
    assert.equal(r.details.automatic, true); assert.equal(r.details.resolution, RESOLUTION);
  }
  assert.equal(rows.find(r => r.target_id === open)!.details.cabinetId, liveDown!.toLowerCase());
  // A repeat closes and audits nothing more.
  assert.equal((await closeSiteOutageAlerts(db.app, "site-outage", [open, claimed], WINDOW, RESOLUTION)).length, 0);
  assert.equal((await audits([open, claimed])).length, 2);
});

test("the window is the one given: a cabinet heard from just outside it does not make the site live", async () => {
  const [k] = await site([{ agoSeconds: 600 }, { agoSeconds: 400 }]);
  const id = await alert(k!);
  assert.equal((await closeSiteOutageAlerts(db.app, "site-outage", [id], WINDOW, RESOLUTION)).length, 0);
  assert.equal((await row(id)).state, "open");
  assert.equal((await closeSiteOutageAlerts(db.app, "site-outage", [id], 500, RESOLUTION)).length, 1);
});

test("a close in a transaction that rolls back leaves the alert open and unaudited", async () => {
  const [k] = await site([{ agoSeconds: 10 }, { agoSeconds: 3_600 }]);
  const id = await alert(k!);
  await assert.rejects(db.app.transaction(async tx => {
    assert.equal((await closeSiteOutageAlerts(tx, "site-outage", [id], WINDOW, RESOLUTION)).length, 1);
    throw new Error("rolled back");
  }), /rolled back/);
  assert.equal((await row(id)).state, "open");
  assert.equal((await audits([id])).length, 0);
});

test("anything but a closer, 1 to 500 alert ids, a whole window of seconds and a plain resolution is refused before the database is touched", async () => {
  const [k] = await site([{ agoSeconds: 10 }, { agoSeconds: 3_600 }]);
  const id = await alert(k!);
  let refused = 0;
  const refuse = async (p: Promise<unknown>, what: string) => {
    await assert.rejects(p, (e: Error) => !/reached the database/.test(e.message), what); refused++;
  };
  for (const by of [undefined, null, "", "Site", "-x", "a b", "a".repeat(65), 7])
    await refuse(closeSiteOutageAlerts(untouched, by as never, [id], WINDOW, RESOLUTION), `closer ${String(by)}`);
  const tooMany = Array.from({ length: SITE_OUTAGE_CLOSE_SLICE + 1 }, () => randomUUID());
  for (const ids of [undefined, null, "", [], id, [id, "not-an-id"], [`${id}'; DROP TABLE alerts; --`], [42], [null], tooMany, { length: 1, 0: id }])
    await refuse(closeSiteOutageAlerts(untouched, "site-outage", ids as never, WINDOW, RESOLUTION), `ids ${String(ids).slice(0, 40)}`);
  for (const w of [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_401, "300"])
    await refuse(closeSiteOutageAlerts(untouched, "site-outage", [id], w as never, RESOLUTION), `window ${String(w)}`);
  for (const r of [undefined, null, "", "   ", "a".repeat(501), "tab\tin", "nul\u0000", 3])
    await refuse(closeSiteOutageAlerts(untouched, "site-outage", [id], WINDOW, r as never), `resolution ${String(r)}`);
  assert.equal(refused, 36);
  // The largest slice is accepted, and closes only the one real alert in it.
  const full = [id, ...Array.from({ length: SITE_OUTAGE_CLOSE_SLICE - 1 }, () => randomUUID())];
  assert.equal((await closeSiteOutageAlerts(db.app, "site-outage", full, WINDOW, RESOLUTION)).length, 1);
});

// An agent's firewall_changed event goes into the cabinet's firewall history through commands.ts, the table's owner (F21.R2,
// decision-log D84). The first event for a change made through the platform confirms the row its write already recorded; any other event
// is a further change. The cabinet id and the event are checked against the contract before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recordFirewallEvent } from "../src/services/commands.js";
import { storeEvents } from "../src/services/events.js";
import type { Event } from "../src/contracts.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function cabinet(): Promise<{ k: string; user: string }> {
  const client = randomUUID(), site = randomUUID(), k = randomUUID(), user = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, $2, 'U', 'tier2')", [user, `u.${user.slice(0, 8)}`]);
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [k, site]);
  return { k, user };
}
/** A firewall write made through the platform, with the history row its own result left (commands.ts, on the result). */
async function platformWrite(k: string, user: string): Promise<string> {
  const id = randomUUID();
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status)
                      VALUES ($1, $2, 'firewall.set_profile', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'succeeded')`, [id, k, user]);
  await db.app.query("INSERT INTO firewall_changes (cabinet_id, command_id, explained, operation, occurred_at) VALUES ($1, $2, 1, 'firewall.set_profile', SYSUTCDATETIME())", [k, id]);
  return id;
}
const event = (o: Partial<Event> = {}): Event =>
  ({ eventId: randomUUID(), kind: "firewall_changed", occurredAt: new Date().toISOString(), severityHint: "minor", detail: { message: "1 changed" }, ...o }) as Event;
const history = async (k: string) => (await db.app.query<{ command_id: string | null; event_id: string | null; explained: boolean; operation: string | null }>(
  "SELECT command_id, event_id, explained, operation FROM firewall_changes WHERE cabinet_id = $1", [k])).rows;

test("the first event for a platform write confirms its row; a later one for the same command, and one with no command, are further changes", async () => {
  const { k, user } = await cabinet();
  const cmd = await platformWrite(k, user);
  const first = event({ commandId: cmd }), later = event({ commandId: cmd }), outside = event();
  await recordFirewallEvent(db.app, k, first);
  assert.deepEqual(await history(k), [{ command_id: cmd, event_id: first.eventId, explained: true, operation: "firewall.set_profile" }], "confirmed, not added");
  await recordFirewallEvent(db.app, k, later);
  await recordFirewallEvent(db.app, k, outside);
  const rows = await history(k);
  assert.equal(rows.length, 3);
  const byEvent = (id: string) => rows.find(r => r.event_id === id);
  assert.deepEqual(byEvent(later.eventId), { command_id: cmd, event_id: later.eventId, explained: true, operation: null });
  assert.deepEqual(byEvent(outside.eventId), { command_id: null, event_id: outside.eventId, explained: false, operation: null });
});

test("storeEvents puts a stored firewall_changed event into the history, once, and other kinds not at all", async () => {
  const { k } = await cabinet();
  const fw = event(), other = event({ kind: "smart_warning", severityHint: "major" } as Partial<Event>);
  await storeEvents(db.app, k, { events: [fw, other] });
  await storeEvents(db.app, k, { events: [fw] }); // the same event again: already stored, so not recorded again
  assert.deepEqual((await history(k)).map(r => r.event_id), [fw.eventId]);
});

test("anything but a cabinet id and a firewall_changed event within its contract is refused before the database is touched", async () => {
  const { k } = await cabinet();
  for (const bad of ["", "not-an-id", "' OR 1=1 --", `${k}; DELETE FROM firewall_changes`, null, undefined, 42, {}])
    await assert.rejects(recordFirewallEvent(db.app, bad as never, event()), /cabinet id/, String(bad));
  const hostile: unknown[] = [
    undefined, null, "firewall_changed", [], {},
    { ...event(), eventId: "not-an-id" },
    { ...event(), eventId: "'; DROP TABLE firewall_changes; --" },
    { ...event(), commandId: "x" },
    { ...event(), occurredAt: "yesterday" },
    { ...event(), detail: { message: "x", extra: 1 } },
    { ...event(), detail: { message: "x".repeat(100_000) } },
    { ...event(), unexpected: true },
    (({ occurredAt: _drop, ...rest }) => rest)(event()),
  ];
  for (const e of hostile) await assert.rejects(recordFirewallEvent(db.app, k, e as never), Error, JSON.stringify(e)?.slice(0, 80));
  await assert.rejects(recordFirewallEvent(db.app, k, event({ kind: "smart_warning" } as Partial<Event>)), /only a firewall_changed event/);
  assert.deepEqual(await history(k), [], "nothing was recorded");
});

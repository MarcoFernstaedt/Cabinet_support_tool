// A cabinet's last contact, now written in one place, cabinets.ts, the owner of the table (F21.R2, decision-log D126): the presence
// batch hands its contacts to recordContacts. It writes only active cabinets, never moves a contact backwards, writes more than one
// statement's worth, and checks every id and time before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recordContacts } from "../src/services/cabinets.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function cabinets(statuses: string[]): Promise<string[]> {
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  const ids: string[] = [];
  for (const [i, status] of statuses.entries()) {
    const id = randomUUID();
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'standalone', $4)", [id, site, `K${i}`, status]);
    ids.push(id);
  }
  return ids;
}
const heard = async (id: string) => (await db.app.query<{ at: Date | null }>("SELECT last_heartbeat_at AS at FROM cabinets WHERE id = $1", [id])).rows[0]!.at?.toISOString() ?? null;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };
const T1 = "2026-11-18T10:00:00.000Z", T2 = "2026-11-18T10:01:00.000Z";

test("only active cabinets are written, a contact is never moved backwards, and another cabinet is not touched", async () => {
  const [active, pending, removed, other] = await cabinets(["active", "pending", "removed", "active"]);
  assert.equal(await recordContacts(db.app, [{ id: active!, at: T2 }, { id: pending!, at: T2 }, { id: removed!, at: T2 }]), 1);
  assert.deepEqual([await heard(active!), await heard(pending!), await heard(removed!), await heard(other!)], [T2, null, null, null]);
  assert.equal(await recordContacts(db.app, [{ id: active!.toUpperCase(), at: T1 }]), 0, "an older contact");
  assert.equal(await heard(active!), T2);
  assert.equal(await recordContacts(db.app, []), 0);
});

test("more contacts than one statement takes are all written", async () => {
  const ids = await cabinets(Array.from({ length: 3 }, () => "active"));
  // 500 to a statement: the real cabinets sit in the first, second and third statements, among ids that match nothing.
  const contacts: { id: string; at: string }[] = Array.from({ length: 1001 }, () => ({ id: randomUUID(), at: T1 }));
  contacts[0] = { id: ids[0]!, at: T1 }; contacts[700] = { id: ids[1]!, at: T1 }; contacts[1000] = { id: ids[2]!, at: T1 };
  assert.equal(await recordContacts(db.app, contacts), 3);
  for (const id of ids) assert.equal(await heard(id), T1);
});

test("every id and time is checked before the database is touched, each refusal with its own reason", async () => {
  const id = randomUUID();
  const cases: [string, unknown, RegExp][] = [
    ["not a list", { id, at: T1 }, /contacts are a list of cabinet ids and times/],
    ["no list", undefined, /contacts are a list of cabinet ids and times/],
    ["an id that is not a uuid", [{ id: "1' OR '1'='1", at: T1 }], /a contact names a cabinet by its uuid/],
    ["no id", [{ at: T1 }], /a contact names a cabinet by its uuid/],
    ["an entry that is not an object", [id], /a contact names a cabinet by its uuid/],
    ["a null entry", [null], /a contact names a cabinet by its uuid/],
    ["a bad entry after a good one", [{ id, at: T1 }, { id: "x", at: T1 }], /a contact names a cabinet by its uuid/],
    ["a time that is a number", [{ id, at: Date.now() }], /a contact time is an ISO 8601 UTC time/],
    ["a time in another zone", [{ id, at: "2026-11-18T10:00:00.000+01:00" }], /a contact time is an ISO 8601 UTC time/],
    ["a time with SQL in it", [{ id, at: "2026-11-18'; DROP TABLE cabinets; --" }], /a contact time is an ISO 8601 UTC time/],
    ["a month that does not exist", [{ id, at: "2026-13-18T10:00:00.000Z" }], /a contact time is an ISO 8601 UTC time/],
  ];
  for (const [name, contacts, reason] of cases) await assert.rejects(recordContacts(untouched, contacts as never), reason, name);
  assert.equal(cases.length, 11);
});

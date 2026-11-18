// What a replacement writes to the cabinets table, now through the owners (F21.R2, decision-log D129): cabinets.ts renames the old
// cabinet and retires it, and sync-cabinets.ts, the owner of the sync link, moves a replaced sync cabinet's satellites. Each writes only the
// cabinet or cabinets it names, and checks its input before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renameCabinet, retireCabinet } from "../src/services/cabinets.js";
import { moveSatellites } from "../src/services/sync-cabinets.js";
import { isUniqueViolation, type Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function site(): Promise<string> {
  const client = randomUUID(), id = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [id, client]);
  return id;
}
async function cabinet(siteId: string, name: string, role = "standalone", status = "active", syncCabinetId: string | null = null): Promise<string> {
  const id = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, sync_cabinet_id) VALUES ($1, $2, $3, $4, $5, $6)", [id, siteId, name, role, status, syncCabinetId]);
  return id;
}
const of = async (id: string) => (await db.app.query<{ name: string; status: string; link: string | null }>(
  "SELECT name, status, LOWER(CAST(sync_cabinet_id AS char(36))) AS link FROM cabinets WHERE id = $1", [id])).rows[0]!;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a rename writes only the cabinet it names, a name in use fails with the unique-index error, and a missing cabinet answers false", async () => {
  const s = await site();
  const a = await cabinet(s, "ICU 1"), b = await cabinet(s, "ICU 2");
  assert.equal(await renameCabinet(db.app, a, "ICU 1 (replaced 2026-11-18)"), true);
  assert.deepEqual([(await of(a)).name, (await of(b)).name], ["ICU 1 (replaced 2026-11-18)", "ICU 2"]);
  await assert.rejects(renameCabinet(db.app, a.toUpperCase(), "icu 2"), e => isUniqueViolation(e), "another cabinet's name at the site");
  assert.equal(await renameCabinet(db.app, randomUUID(), "Nobody"), false);
});

test("retiring marks only the cabinet it names removed and keeps its record; a missing cabinet answers false", async () => {
  const s = await site();
  const a = await cabinet(s, "Pharmacy"), b = await cabinet(s, "Lab");
  assert.equal(await retireCabinet(db.app, a), true);
  assert.deepEqual([(await of(a)).status, (await of(a)).name, (await of(b)).status], ["removed", "Pharmacy", "active"]);
  assert.equal(await retireCabinet(db.app, randomUUID()), false);
});

test("a sync cabinet's satellites move to another; a removed one and another sync cabinet's stay where they are", async () => {
  const s = await site();
  const oldSync = await cabinet(s, "Sync old", "sync"), newSync = await cabinet(s, "Sync new", "sync"), other = await cabinet(s, "Sync other", "sync");
  const live = await cabinet(s, "Sat 1", "satellite", "active", oldSync), pending = await cabinet(s, "Sat 2", "satellite", "pending", oldSync);
  const gone = await cabinet(s, "Sat 3", "satellite", "removed", oldSync), elsewhere = await cabinet(s, "Sat 4", "satellite", "active", other);
  assert.equal(await moveSatellites(db.app, oldSync, newSync.toUpperCase()), 2);
  assert.deepEqual([(await of(live)).link, (await of(pending)).link, (await of(gone)).link, (await of(elsewhere)).link], [newSync, newSync, oldSync, other]);
  assert.equal(await moveSatellites(db.app, oldSync, newSync), 0, "nothing left to move");
});

test("ids and names are checked before the database is touched, each refusal with its own reason", async () => {
  const id = randomUUID();
  const rename: [string, unknown, unknown, RegExp][] = [
    ["an id that is not a uuid", "1' OR '1'='1", "ICU", /a cabinet id is required to rename it/],
    ["no id", undefined, "ICU", /a cabinet id is required to rename it/],
    ["an empty name", id, "", /a cabinet name is 1 to 128 characters with no control characters or angle brackets/],
    ["a name with markup", id, "<script>x</script>", /a cabinet name is 1 to 128 characters/],
    ["a name too long", id, "K".repeat(129), /a cabinet name is 1 to 128 characters/],
    ["a name that is not text", id, 7, /a cabinet name is 1 to 128 characters/],
  ];
  for (const [label, target, name, reason] of rename) await assert.rejects(renameCabinet(untouched, target as string, name as string), reason, label);
  for (const bad of ["x", undefined, null, 7, `${id}'; --`]) await assert.rejects(retireCabinet(untouched, bad as string), /a cabinet id is required to retire it/, String(bad));
  const move: [string, unknown, unknown, RegExp][] = [
    ["a from that is not a uuid", "x", id, /satellites move from one sync cabinet's uuid to another's/],
    ["a to that is not a uuid", id, "1; DROP TABLE cabinets", /satellites move from one sync cabinet's uuid to another's/],
    ["no to", id, null, /satellites move from one sync cabinet's uuid to another's/],
    ["the same cabinet", id, id.toUpperCase(), /satellites move to another sync cabinet/],
  ];
  for (const [label, from, to, reason] of move) await assert.rejects(moveSatellites(untouched, from as string, to as string), reason, label);
  assert.equal(rename.length + move.length, 10);
});

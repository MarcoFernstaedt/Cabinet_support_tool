// Changing a cabinet's role, now written in one place, cabinets.ts, the owner of the table (F21.R2, decision-log D127): the Admin's
// role change goes through changeCabinetRole. The sync columns follow the role, only an active cabinet is changed, it answers the role it
// had and its site, and the id, the role and the address are checked before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { changeCabinetRole } from "../src/services/cabinets.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

let site = "";
async function cabinet(role: string, status = "active", extra: { sync_cabinet_id?: string; sync_address?: string; sync_address_source?: string } = {}): Promise<string> {
  if (!site) {
    const client = randomUUID(); site = randomUUID();
    await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
    await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  }
  const id = randomUUID();
  await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, sync_cabinet_id, sync_address, sync_address_source)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, site, `K ${id.slice(0, 6)}`, role, status, extra.sync_cabinet_id ?? null, extra.sync_address ?? null, extra.sync_address_source ?? null]);
  return id;
}
const row = async (id: string) => (await db.app.query<{ role: string; link: string | null; address: string | null; source: string | null }>(
  "SELECT role, LOWER(CAST(sync_cabinet_id AS char(36))) AS link, sync_address AS address, sync_address_source AS source FROM cabinets WHERE id = $1", [id])).rows[0]!;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("the sync columns follow the role, and the role it had and its site come back", async () => {
  const sync = await cabinet("sync", "active", { sync_address: "10.0.0.5", sync_address_source: "admin" });
  const sat = await cabinet("satellite", "active", { sync_cabinet_id: sync });
  const plain = await cabinet("standalone");

  // Becoming a sync cabinet starts from the address it reported.
  const r = await changeCabinetRole(db.app, plain, "sync", "192.168.1.20");
  assert.equal(r?.oldRole, "standalone");
  assert.equal(r?.siteId.toLowerCase(), site);
  assert.deepEqual(await row(plain), { role: "sync", link: null, address: "192.168.1.20", source: "reported" });
  // With nothing reported, it has no address yet.
  const quiet = await cabinet("standalone");
  await changeCabinetRole(db.app, quiet, "sync", null);
  assert.deepEqual(await row(quiet), { role: "sync", link: null, address: null, source: null });
  // A sync cabinet that stays one keeps the address an Admin gave it, whatever was reported.
  await changeCabinetRole(db.app, sync, "sync", "192.168.1.99");
  assert.deepEqual(await row(sync), { role: "sync", link: null, address: "10.0.0.5", source: "admin" });
  // A satellite that stays one keeps its link; one that stops being a satellite drops it.
  await changeCabinetRole(db.app, sat, "satellite", null);
  assert.equal((await row(sat)).link, sync);
  assert.equal((await changeCabinetRole(db.app, sat.toUpperCase(), "standalone", null))?.oldRole, "satellite");
  assert.deepEqual(await row(sat), { role: "standalone", link: null, address: null, source: null });
  // A sync cabinet that stops being one drops its address.
  await changeCabinetRole(db.app, sync, "satellite", null);
  assert.deepEqual(await row(sync), { role: "satellite", link: null, address: null, source: null });
});

test("only an active cabinet is changed", async () => {
  for (const status of ["pending", "removed"]) {
    const id = await cabinet("standalone", status);
    assert.equal(await changeCabinetRole(db.app, id, "sync", "10.1.1.1"), null, status);
    assert.deepEqual(await row(id), { role: "standalone", link: null, address: null, source: null }, status);
  }
  assert.equal(await changeCabinetRole(db.app, randomUUID(), "sync", null), null, "no such cabinet");
});

test("the id, the role and the address are checked before the database is touched, each refusal with its own reason", async () => {
  const id = randomUUID();
  const cases: [string, unknown, unknown, unknown, RegExp][] = [
    ["an id that is not a uuid", "1' OR '1'='1", "sync", null, /a cabinet id is required to change its role/],
    ["no id", undefined, "sync", null, /a cabinet id is required to change its role/],
    ["a role that does not exist", id, "admin", null, /a cabinet's role is sync, satellite or standalone/],
    ["a role in another case", id, "Sync", null, /a cabinet's role is sync, satellite or standalone/],
    ["a role with SQL in it", id, "sync'; DROP TABLE cabinets; --", null, /a cabinet's role is sync, satellite or standalone/],
    ["no role", id, undefined, null, /a cabinet's role is sync, satellite or standalone/],
    ["a public address", id, "sync", "8.8.8.8", /a reported sync address is null or a private IPv4 address/],
    ["an address with a leading zero", id, "sync", "10.0.0.05", /a reported sync address is null or a private IPv4 address/],
    ["an address with a mask", id, "sync", "10.0.0.5/24", /a reported sync address is null or a private IPv4 address/],
    ["an address that is not text", id, "sync", 167772165, /a reported sync address is null or a private IPv4 address/],
    ["an address left out", id, "sync", undefined, /a reported sync address is null or a private IPv4 address/],
  ];
  for (const [name, target, role, reported, reason] of cases)
    await assert.rejects(changeCabinetRole(untouched, target as string, role as string, reported as string), reason, name);
  assert.equal(cases.length, 11);
});

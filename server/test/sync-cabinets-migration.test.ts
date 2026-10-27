// Migration 0011 against a real SQL Server, on data shaped as it was before (docs/spec/05-server-spec.md "Sync cabinets and satellites").
// A site with exactly one sync cabinet keeps its typed address, now as that sync cabinet's Admin-set address, and its satellites are
// linked to it, so nothing changes on the wire. Satellites at a site with no sync cabinet, or several, are left for an Admin to assign.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { connectOwner, migrate, readMigrations } from "../src/db/migrate.js";
import { ADMIN_URL } from "./database.js";

test("migration 0011 moves each site's address to its only sync cabinet and links the satellites", async t => {
  const name = "cabinet_test_" + randomBytes(6).toString("hex");
  const admin = await connectOwner(ADMIN_URL);
  await admin.request().query(`CREATE DATABASE ${name}`);
  await admin.close();
  const url = new URL(ADMIN_URL); url.pathname = "/" + name;
  const owner = await connectOwner(url.toString());
  t.after(async () => {
    await owner.close();
    const c = await connectOwner(ADMIN_URL);
    await c.request().query(`ALTER DATABASE ${name} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${name};`);
    await c.close();
  });

  const all = readMigrations();
  await migrate(owner, all.filter(m => m.version < "0011"));

  const client = randomUUID();
  const [one, none, two, noAddress] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const k = { oneSync: randomUUID(), oneSat: randomUUID(), oneSat2: randomUUID(), oneSolo: randomUUID(), oneRemovedSat: randomUUID(),
    noneSat: randomUUID(), twoSyncA: randomUUID(), twoSyncB: randomUUID(), twoSat: randomUUID(), naSync: randomUUID(), naSat: randomUUID() };
  const q = (text: string) => owner.request().query(text);
  await q(`INSERT INTO clients (id, name) VALUES ('${client}', 'Migrated')`);
  await q(`INSERT INTO sites (id, client_id, name, sync_address) VALUES ('${one}', '${client}', 'One', '10.20.0.15'), ('${none}', '${client}', 'None', '10.21.0.15'),
           ('${two}', '${client}', 'Two', '10.22.0.15'), ('${noAddress}', '${client}', 'No address', NULL)`);
  const row = (id: string, site: string, nm: string, role: string, status = "active") => `('${id}', '${site}', '${nm}', '${role}', '${status}')`;
  await q(`INSERT INTO cabinets (id, site_id, name, role, status) VALUES
    ${row(k.oneSync, one, "SYNC", "sync")}, ${row(k.oneSat, one, "SAT 1", "satellite")}, ${row(k.oneSat2, one, "SAT 2", "satellite")},
    ${row(k.oneSolo, one, "SOLO", "standalone")}, ${row(k.oneRemovedSat, one, "OLD SAT", "satellite", "removed")},
    ${row(k.noneSat, none, "SAT", "satellite")},
    ${row(k.twoSyncA, two, "SYNC A", "sync")}, ${row(k.twoSyncB, two, "SYNC B", "sync")}, ${row(k.twoSat, two, "SAT", "satellite")},
    ${row(k.naSync, noAddress, "SYNC", "sync")}, ${row(k.naSat, noAddress, "SAT", "satellite")}`);

  assert.deepEqual(await migrate(owner, all.filter(m => m.version < "0012")), ["0011_sync_cabinets"]);

  const rows = new Map((await q("SELECT id, sync_cabinet_id, sync_address, sync_address_source FROM cabinets")).recordset
    .map((r: { id: string; sync_cabinet_id: string | null; sync_address: string | null; sync_address_source: string | null }) =>
      [r.id.toLowerCase(), { link: r.sync_cabinet_id?.toLowerCase() ?? null, address: r.sync_address, source: r.sync_address_source }]));
  const get = (id: string) => rows.get(id)!;

  // One sync cabinet: the address moves to it as an Admin's, and the live satellites follow it. Others are untouched.
  assert.deepEqual(get(k.oneSync), { link: null, address: "10.20.0.15", source: "admin" });
  assert.equal(get(k.oneSat).link, k.oneSync);
  assert.equal(get(k.oneSat2).link, k.oneSync);
  assert.equal(get(k.oneSolo).link, null);
  assert.equal(get(k.oneRemovedSat).link, null, "a removed satellite is not linked");
  // No sync cabinet, or two: nothing is guessed.
  assert.equal(get(k.noneSat).link, null);
  assert.equal(get(k.twoSat).link, null);
  assert.deepEqual([get(k.twoSyncA).address, get(k.twoSyncB).address], [null, null]);
  // One sync cabinet but no address: linked, address still to come.
  assert.deepEqual(get(k.naSync), { link: null, address: null, source: null });
  assert.equal(get(k.naSat).link, k.naSync);

  // The site's column is gone; its ports stay.
  const columns = (await q("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('sites')")).recordset.map((r: { name: string }) => r.name);
  assert.ok(!columns.includes("sync_address"));
  assert.ok(columns.includes("sync_ports"));

  // The constraints hold: an address always has a source, a source never stands alone, a cabinet is not its own sync cabinet.
  for (const bad of [
    `UPDATE cabinets SET sync_address = '10.0.0.1' WHERE id = '${k.twoSyncA}'`,
    `UPDATE cabinets SET sync_address_source = 'admin' WHERE id = '${k.twoSyncA}'`,
    `UPDATE cabinets SET sync_address = '10.0.0.1', sync_address_source = 'agent' WHERE id = '${k.twoSyncA}'`,
    `UPDATE cabinets SET sync_address = '10.0.0.1; --', sync_address_source = 'admin' WHERE id = '${k.twoSyncA}'`,
    `UPDATE cabinets SET sync_cabinet_id = id WHERE id = '${k.twoSat}'`,
    `UPDATE cabinets SET sync_cabinet_id = '${randomUUID()}' WHERE id = '${k.twoSat}'`,
  ]) await assert.rejects(q(bad), bad);
});

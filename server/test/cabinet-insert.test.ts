// Creating a cabinet, now in one place, cabinets.ts, the owner of the table (F21.R2, decision-log D128): an enrolment approval creates
// the cabinet through insertCabinet. It writes every field it is given, answers false for a name in use at the site (a removed cabinet
// keeps its name), and checks every field before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { insertCabinet, type NewCabinet } from "../src/services/cabinets.js";
import type { Queryable } from "../src/db/db.js";
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
const plain = (siteId: string, name: string, over: Partial<NewCabinet> = {}): NewCabinet => ({
  id: randomUUID(), siteId, name, role: "standalone", hostname: "CAB-01", serialNumber: "SN-1", agentVersion: "1.4.0", architecture: "windows-x64",
  syncCabinetId: null, replacesCabinetId: null, scannerHardwareIds: null, watchedServices: null, inOffice: false,
  syncAddress: null, syncAddressSource: null, ...over });
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("every field is written as given, and the cabinet is active", async () => {
  const s = await site();
  const old = plain(s, "Old ICU", { role: "sync" });
  assert.equal(await insertCabinet(db.app, old), true);
  const k = plain(s, "ICU 1", { role: "sync", hostname: "ICU-CAB", serialNumber: null, agentVersion: "2.0.1-beta.1", architecture: null,
    replacesCabinetId: old.id, scannerHardwareIds: '["USB\\\\VID_1234"]', watchedServices: '["Spooler"]',
    inOffice: true, syncAddress: "10.0.0.5", syncAddressSource: "admin" });
  assert.equal(await insertCabinet(db.app, k), true);
  // The connection reads the JSON settings back parsed; the stored text is what was given.
  const row = (await db.app.query<Record<string, unknown>>(
    `SELECT LOWER(CAST(site_id AS char(36))) AS site, name, role, status, hostname, serial_number, agent_version, architecture, sync_cabinet_id,
            LOWER(CAST(replaces_cabinet_id AS char(36))) AS replaces, scanner_hardware_ids, watched_services, in_office, sync_address, sync_address_source
       FROM cabinets WHERE id = $1`, [k.id])).rows[0]!;
  assert.deepEqual(row, { site: s, name: "ICU 1", role: "sync", status: "active", hostname: "ICU-CAB", serial_number: null, agent_version: "2.0.1-beta.1",
    architecture: null, sync_cabinet_id: null, replaces: old.id, scanner_hardware_ids: ["USB\\VID_1234"], watched_services: ["Spooler"],
    in_office: true, sync_address: "10.0.0.5", sync_address_source: "admin" });
  // The settings as the connection reads them back from the replaced cabinet's row, parsed, are taken and stored as their JSON.
  const copy = plain(s, "ICU 3", { scannerHardwareIds: ["USB\\VID_1234"] as never, watchedServices: ["Spooler"] as never });
  assert.equal(await insertCabinet(db.app, copy), true);
  assert.deepEqual((await db.app.query<Record<string, unknown>>("SELECT scanner_hardware_ids, watched_services FROM cabinets WHERE id = $1", [copy.id])).rows[0],
    { scanner_hardware_ids: ["USB\\VID_1234"], watched_services: ["Spooler"] });
  // A satellite placed with its sync cabinet.
  const sat = plain(s, "ICU 2", { role: "satellite", syncCabinetId: k.id.toUpperCase() });
  assert.equal(await insertCabinet(db.app, sat), true);
  assert.equal((await db.app.query<{ l: string }>("SELECT LOWER(CAST(sync_cabinet_id AS char(36))) AS l FROM cabinets WHERE id = $1", [sat.id])).rows[0]!.l, k.id);
});

test("a name in use at the site is answered false, a removed cabinet keeps its name, and another site may use it", async () => {
  const a = await site(), b = await site();
  assert.equal(await insertCabinet(db.app, plain(a, "Pharmacy")), true);
  const again = plain(a, "pharmacy");
  assert.equal(await insertCabinet(db.app, again), false, "the same name in another case");
  assert.equal((await db.app.query("SELECT 1 AS x FROM cabinets WHERE id = $1", [again.id])).rows.length, 0, "nothing written");
  const gone = plain(a, "Old Pharmacy");
  await insertCabinet(db.app, gone);
  await db.app.query("UPDATE cabinets SET status = 'removed' WHERE id = $1", [gone.id]);
  assert.equal(await insertCabinet(db.app, plain(a, "Old Pharmacy")), false, "a removed cabinet keeps its name");
  assert.equal(await insertCabinet(db.app, plain(b, "Pharmacy")), true, "another site");
});

test("every field is checked before the database is touched, each refusal with its own reason", async () => {
  const s = randomUUID();
  const ids = /a new cabinet's id and site are uuids/, name = /a cabinet name is 1 to 128 characters with no control characters or angle brackets/,
    role = /a cabinet's role is sync, satellite or standalone/, facts = /a new cabinet's reported facts are its hostname, serial, agent version and architecture/,
    links = /a sync cabinet and a replaced cabinet are uuids or null/, settings = /a replaced cabinet's settings are what its row held, or null/,
    address = /a carried-over sync address is a private IPv4 address an Admin set, or none/;
  const cases: [string, unknown, RegExp][] = [
    ["no cabinet", null, /a new cabinet is required/],
    ["an id that is not a uuid", plain(s, "K", { id: "1' OR '1'='1" }), ids],
    ["a site that is not a uuid", plain(s, "K", { siteId: "site" }), ids],
    ["an empty name", plain(s, ""), name],
    ["a name with markup", plain(s, "<img src=x onerror=alert(1)>"), name],
    ["a name too long", plain(s, "K".repeat(129)), name],
    ["a name with a new line", plain(s, "ICU\n1"), name],
    ["a role that does not exist", plain(s, "K", { role: "admin" }), role],
    ["an empty hostname", plain(s, "K", { hostname: "" }), facts],
    ["a hostname too long", plain(s, "K", { hostname: "h".repeat(256) }), facts],
    ["a serial that is a number", plain(s, "K", { serialNumber: 7 as never }), facts],
    ["an agent version too long", plain(s, "K", { agentVersion: "1".repeat(65) }), facts],
    ["an architecture that does not exist", plain(s, "K", { architecture: "arm64" }), facts],
    ["a sync cabinet that is not a uuid", plain(s, "K", { syncCabinetId: "x; DROP TABLE cabinets" }), links],
    ["a replaced cabinet that is not a uuid", plain(s, "K", { replacesCabinetId: "old" }), links],
    ["scanner IDs that are a number", plain(s, "K", { scannerHardwareIds: 7 as never }), settings],
    ["watched services that are a date", plain(s, "K", { watchedServices: new Date() as never }), settings],
    ["in office that is a number", plain(s, "K", { inOffice: 1 as never }), settings],
    ["a public address", plain(s, "K", { syncAddress: "8.8.8.8", syncAddressSource: "admin" }), address],
    ["an address that was reported", plain(s, "K", { syncAddress: "10.0.0.5", syncAddressSource: "reported" as never }), address],
    ["an address without its source", plain(s, "K", { syncAddress: "10.0.0.5", syncAddressSource: null }), address],
    ["a source without an address", plain(s, "K", { syncAddress: null, syncAddressSource: "admin" }), address],
  ];
  for (const [label, k, reason] of cases) await assert.rejects(insertCabinet(untouched, k as NewCabinet), reason, label);
  assert.equal(cases.length, 22);
});

// Writing a client's or a site's scanner hardware IDs, now in one place, device-settings.ts, the owner of that column on both (F21.R2,
// decision-log D121). It writes the level it names, only a live one, can clear a list, and checks the level, the id and the list before the
// database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeScannerIds } from "../src/services/device-settings.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function place(): Promise<{ client: string; site: string }> {
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  return { client, site };
}
const ids = async (table: "clients" | "sites", id: string) =>
  ((v: unknown) => (typeof v === "string" ? JSON.parse(v) : v))((await db.app.query<{ v: unknown }>(`SELECT scanner_hardware_ids AS v FROM ${table} WHERE id = $1`, [id])).rows[0]!.v);
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };
const READER = "USB\\VID_1234&PID_5678";

test("each level's IDs are written to that level only, can be cleared to inherit, and a removed one is not written", async () => {
  const a = await place(), b = await place();
  assert.equal(await writeScannerIds(db.app, "client", a.client, [READER, "HID\\VID_0001&PID_0002"]), true);
  assert.equal(await writeScannerIds(db.app, "site", a.site.toUpperCase(), [READER]), true);
  assert.deepEqual([await ids("clients", a.client), await ids("sites", a.site)], [[READER, "HID\\VID_0001&PID_0002"], [READER]]);
  assert.deepEqual([await ids("clients", b.client), await ids("sites", b.site)], [null, null], "another place is not touched");
  assert.equal(await writeScannerIds(db.app, "site", a.site, null), true);
  assert.equal(await ids("sites", a.site), null, "null clears the site's own IDs, so the client's apply");
  await db.app.query("UPDATE sites SET removed_at = SYSUTCDATETIME() WHERE id = $1", [b.site]);
  assert.equal(await writeScannerIds(db.app, "site", b.site, [READER]), false, "a removed site");
  assert.equal(await writeScannerIds(db.app, "client", randomUUID(), [READER]), false, "no such client");
});

test("the level, the id and the list are checked before the database is touched, each refusal with its own reason", async () => {
  const id = randomUUID();
  const cases: [string, unknown, unknown, unknown, RegExp][] = [
    ["a cabinet is not a level here", "cabinet", id, [READER], /scanner IDs belong to a client or a site here/],
    ["a table name", "clients", id, [READER], /scanner IDs belong to a client or a site here/],
    ["an id that is not a uuid", "client", "1' OR '1'='1", [READER], /the client must be a uuid/],
    ["no id", "site", undefined, [READER], /the site must be a uuid/],
    ["an empty list", "client", id, [], /scanner IDs are null or 1 to 16 distinct hardware IDs/],
    ["seventeen IDs", "client", id, Array.from({ length: 17 }, (_, i) => `USB\\VID_${1000 + i}`), /scanner IDs are null or 1 to 16 distinct hardware IDs/],
    ["one ID twice", "client", id, [READER, READER], /scanner IDs are null or 1 to 16 distinct hardware IDs/],
    ["an ID with a quote", "client", id, ["USB'; DROP TABLE clients; --"], /scanner IDs are null or 1 to 16 distinct hardware IDs/],
    ["an ID with a slash", "client", id, ["USB/VID_1"], /scanner IDs are null or 1 to 16 distinct hardware IDs/],
    ["an empty ID", "client", id, [""], /scanner IDs are null or 1 to 16 distinct hardware IDs/],
    ["an ID too long", "client", id, ["U".repeat(201)], /scanner IDs are null or 1 to 16 distinct hardware IDs/],
    ["an ID that is not text", "client", id, [7], /scanner IDs are null or 1 to 16 distinct hardware IDs/],
    ["a list that is text", "client", id, READER, /scanner IDs are null or 1 to 16 distinct hardware IDs/],
  ];
  for (const [name, level, target, list, reason] of cases)
    await assert.rejects(writeScannerIds(untouched, level as "client", target as string, list as string[]), reason, name);
  assert.equal(cases.length, 13);
});

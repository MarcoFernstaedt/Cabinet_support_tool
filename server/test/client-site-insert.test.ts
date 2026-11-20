// Creating a client or a site row, now in one place, admin.ts, the owner of both tables (F21.R2, decision-log D124): the Admin screens and
// the bulk import both create rows through insertClient and insertSite. They write the row they are given, a name in use fails with the
// database's unique-index error, and the id and the name are checked before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { insertClient, insertSite } from "../src/services/admin.js";
import { isUniqueViolation, type Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a client and a site are created as given, and a name in use fails with the unique-index error", async () => {
  const client = randomUUID(), site = randomUUID(), name = `Mercy ${client.slice(0, 6)}`;
  await insertClient(db.app, client, name);
  await insertSite(db.app, site, client, "North Wing ✓");
  assert.deepEqual((await db.app.query<{ name: string }>("SELECT name FROM clients WHERE id = $1", [client])).rows, [{ name }]);
  assert.deepEqual((await db.app.query<{ client_id: string; name: string }>("SELECT LOWER(CAST(client_id AS char(36))) AS client_id, name FROM sites WHERE id = $1", [site])).rows,
    [{ client_id: client, name: "North Wing ✓" }]);
  await assert.rejects(insertClient(db.app, randomUUID(), name.toUpperCase()), e => isUniqueViolation(e), "the same client name in another case");
  await assert.rejects(insertSite(db.app, randomUUID(), client, "north wing ✓"), e => isUniqueViolation(e), "the same site name in that client");
});

test("the ids and the name are checked before the database is touched, each refusal with its own reason", async () => {
  const id = randomUUID();
  const clientCases: [string, unknown, unknown, RegExp][] = [
    ["an id that is not a uuid", "1' OR '1'='1", "Mercy", /the client id must be a uuid/],
    ["no id", undefined, "Mercy", /the client id must be a uuid/],
    ["an empty name", id, "", /a client name is 1 to 128 characters with no control characters or angle brackets/],
    ["a name too long", id, "M".repeat(129), /a client name is 1 to 128 characters/],
    ["a name with markup", id, "<script>alert(1)</script>", /a client name is 1 to 128 characters/],
    ["a name with a new line", id, "Mercy\nGeneral", /a client name is 1 to 128 characters/],
    ["a name with a null", id, "Mercy\u0000", /a client name is 1 to 128 characters/],
    ["a name that is not text", id, 7, /a client name is 1 to 128 characters/],
  ];
  for (const [name, target, value, reason] of clientCases)
    await assert.rejects(insertClient(untouched, target as string, value as string), reason, name);
  const siteCases: [string, unknown, unknown, unknown, RegExp][] = [
    ["a site id that is not a uuid", "x", id, "North", /the site id must be a uuid/],
    ["a client id that is not a uuid", id, "1; DROP TABLE sites", "North", /the client id must be a uuid/],
    ["no client id", id, null, "North", /the client id must be a uuid/],
    ["a site name with markup", id, id, "<b>North</b>", /a site name is 1 to 128 characters with no control characters or angle brackets/],
    ["an empty site name", id, id, "", /a site name is 1 to 128 characters/],
    ["a site name that is a list", id, id, ["North"], /a site name is 1 to 128 characters/],
  ];
  for (const [name, target, client, value, reason] of siteCases)
    await assert.rejects(insertSite(untouched, target as string, client as string, value as string), reason, name);
  assert.equal(clientCases.length + siteCases.length, 14);
  // 128 characters outside the basic plane is a name the contracts allow; it is not refused by the check.
  const long = "😀".repeat(128);
  await assert.rejects(insertClient(untouched, id, long), /reached the database/);
});

// Writing one level's file-facts paths, with one fixed statement per level (F21.R2, decision-log D123): filefacts-allowlist.ts owns the
// filefacts_paths column of clients, sites and cabinets. It writes the level it names, never a removed one, and checks the level and the id
// before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeAllowlistLevel } from "../src/services/filefacts-allowlist.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function place(): Promise<{ client: string; site: string; cabinet: string }> {
  const client = randomUUID(), site = randomUUID(), cabinet = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [cabinet, site]);
  return { client, site, cabinet };
}
const stored = async (table: "clients" | "sites" | "cabinets", id: string) =>
  ((v: unknown) => (typeof v === "string" ? JSON.parse(v) : v))((await db.app.query<{ v: unknown }>(`SELECT filefacts_paths AS v FROM ${table} WHERE id = $1`, [id])).rows[0]!.v);
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("each level's list is written to that level only; a removed site or cabinet is not written and keeps what it had", async () => {
  const a = await place(), b = await place();
  assert.equal(await writeAllowlistLevel(db.app, "client", a.client, { v: "client" }), true);
  assert.equal(await writeAllowlistLevel(db.app, "site", a.site, { v: "site" }), true);
  assert.equal(await writeAllowlistLevel(db.app, "cabinet", a.cabinet.toUpperCase(), { v: "cabinet" }), true);
  assert.deepEqual([await stored("clients", a.client), await stored("sites", a.site), await stored("cabinets", a.cabinet)], [{ v: "client" }, { v: "site" }, { v: "cabinet" }]);
  assert.deepEqual([await stored("clients", b.client), await stored("sites", b.site), await stored("cabinets", b.cabinet)], [null, null, null], "another place is not touched");
  assert.equal(await writeAllowlistLevel(db.app, "site", a.site, null), true);
  assert.equal(await stored("sites", a.site), null, "null clears the site's own list");
  await db.app.query("UPDATE cabinets SET status = 'removed', filefacts_paths = '{\"v\":\"kept\"}' WHERE id = $1", [b.cabinet]);
  await db.app.query("UPDATE sites SET removed_at = SYSUTCDATETIME() WHERE id = $1", [b.site]);
  assert.equal(await writeAllowlistLevel(db.app, "cabinet", b.cabinet, { v: "x" }), false);
  assert.equal(await writeAllowlistLevel(db.app, "site", b.site, { v: "x" }), false);
  assert.deepEqual([await stored("cabinets", b.cabinet), await stored("sites", b.site)], [{ v: "kept" }, null]);
});

test("the level and the id are checked before the database is touched, each refusal with its own reason", async () => {
  const id = randomUUID();
  const cases: [string, unknown, unknown, RegExp][] = [
    ["a table name", "cabinets", id, /a file-facts list belongs to the fleet, a client, a site or a cabinet/],
    ["no level", undefined, id, /a file-facts list belongs to the fleet, a client, a site or a cabinet/],
    ["an id that is not a uuid", "cabinet", "1' OR '1'='1", /the cabinet must be a uuid/],
    ["no id", "site", undefined, /the site must be a uuid/],
    ["an id with a suffix", "client", `${id}x`, /the client must be a uuid/],
    ["an id that is a list", "client", [id], /the client must be a uuid/],
  ];
  for (const [name, level, key, reason] of cases)
    await assert.rejects(writeAllowlistLevel(untouched, level as "client", key as string, { v: 1 }), reason, name);
  assert.equal(cases.length, 6);
});

// Writing a client's, site's or cabinet's own watched-services list, now in one place, watched-services.ts, the owner of that column on all
// three (F21.R2, decision-log D120). It writes the level it names, only a live one, can clear a list, and checks the level, the id and every
// name before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeWatchedServices } from "../src/services/watched-services.js";
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
const list = async (table: "clients" | "sites" | "cabinets", id: string) =>
  ((w: unknown) => (typeof w === "string" ? JSON.parse(w) : w))((await db.app.query<{ w: unknown }>(`SELECT watched_services AS w FROM ${table} WHERE id = $1`, [id])).rows[0]!.w);
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("each level's list is written to that level only, can be cleared to inherit, and a removed one is not written", async () => {
  const a = await place(), b = await place();
  assert.equal(await writeWatchedServices(db.app, "client", a.client, ["Spooler", "BioScanSvc"]), true);
  assert.equal(await writeWatchedServices(db.app, "site", a.site, ["Dnscache"]), true);
  assert.equal(await writeWatchedServices(db.app, "cabinet", a.cabinet.toUpperCase(), []), true);
  assert.deepEqual([await list("clients", a.client), await list("sites", a.site), await list("cabinets", a.cabinet)], [["Spooler", "BioScanSvc"], ["Dnscache"], []]);
  assert.deepEqual([await list("clients", b.client), await list("sites", b.site), await list("cabinets", b.cabinet)], [null, null, null], "another place is not touched");
  assert.equal(await writeWatchedServices(db.app, "client", a.client, null), true);
  assert.equal(await list("clients", a.client), null, "null clears the client's own list, so the level above applies");
  await db.app.query("UPDATE sites SET removed_at = SYSUTCDATETIME() WHERE id = $1", [b.site]);
  await db.app.query("UPDATE cabinets SET status = 'removed' WHERE id = $1", [b.cabinet]);
  assert.equal(await writeWatchedServices(db.app, "site", b.site, ["Spooler"]), false, "a removed site");
  assert.equal(await writeWatchedServices(db.app, "cabinet", b.cabinet, ["Spooler"]), false, "a removed cabinet");
  assert.equal(await writeWatchedServices(db.app, "client", randomUUID(), ["Spooler"]), false, "no such client");
});

test("the level, the id and every name are checked before the database is touched, each refusal with its own reason", async () => {
  const id = randomUUID();
  const cases: [string, unknown, unknown, unknown, RegExp][] = [
    ["the fleet is not a level here", "fleet", id, [], /a watched list is a client's, a site's or a cabinet's/],
    ["a table name", "clients", id, [], /a watched list is a client's, a site's or a cabinet's/],
    ["no level", undefined, id, [], /a watched list is a client's, a site's or a cabinet's/],
    ["an id that is not a uuid", "site", "1' OR '1'='1", [], /the site must be a uuid/],
    ["no id", "cabinet", undefined, [], /the cabinet must be a uuid/],
    ["a list that is text", "client", id, "Spooler", /a watched list is null or at most 16 service names/],
    ["seventeen names", "client", id, Array.from({ length: 17 }, (_, i) => `Svc${i}`), /a watched list is null or at most 16 service names/],
    ["a name with a quote", "client", id, ["Spooler'; DROP TABLE clients; --"], /a watched list is null or at most 16 service names/],
    ["an empty name", "client", id, [""], /a watched list is null or at most 16 service names/],
    ["a name that is not text", "client", id, [7], /a watched list is null or at most 16 service names/],
    ["a name with a slash", "client", id, ["a/b"], /a watched list is null or at most 16 service names/],
  ];
  for (const [name, level, target, names, reason] of cases)
    await assert.rejects(writeWatchedServices(untouched, level as "client", target as string, names as string[]), reason, name);
  assert.equal(cases.length, 11);
});

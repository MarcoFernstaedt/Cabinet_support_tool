// Clients and sites in bulk (F6.R4, decision-log D39): a list previewed without a code, then imported by an Admin with a code bound to
// exactly those rows, in one transaction. What already exists is used as it is, so the list can be imported again once extended; each
// client and site has the audit entry it has when created on its own. Through the real console routes on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let ada: Account, tier2: Account;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [ada, tier2] = [await h.account("admin"), await h.account("tier2")];
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

type Row = { client: string; site: string };
const tag = () => randomBytes(3).toString("hex");
const preview = (rows: Row[], who: Account = ada) => call("POST", "/api/admin/import/preview", { rows }, who);
async function importRows(rows: Row[], who: Account = ada, confirmFor: Row[] = rows) {
  return call("POST", "/api/admin/import", { rows, stepUpToken: await h.codeToken(who, "fleet.import", "fleet", { rows: confirmFor }) }, who);
}
const sitesOf = async (client: string) => (await db.app.query<{ name: string }>(
  "SELECT s.name FROM sites s JOIN clients c ON c.id = s.client_id WHERE c.name = $1 AND s.removed_at IS NULL ORDER BY s.name", [client])).rows.map(r => r.name);
const count = async (table: "clients" | "sites") => Number((await db.app.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);

test("a list is previewed, then imported in one action: new clients and sites are created and audited, and what exists is used as it is", async () => {
  const [a, b] = [`Harbour ${tag()}`, `Inland ${tag()}`];
  // Harbour exists already, with its Pier site.
  const harbour = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [harbour, a]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [randomUUID(), harbour]);
  const rows = [{ client: a, site: "Pier" }, { client: a, site: "Dock 2" }, { client: b, site: "North" }, { client: b.toUpperCase(), site: "South" }];
  const before = [await count("clients"), await count("sites")];

  const p = await preview(rows);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.rows.map((r: { newClient: boolean; newSite: boolean }) => [r.newClient, r.newSite]), [[false, false], [false, true], [true, true], [true, true]]);
  assert.deepEqual([p.body.newClients, p.body.newSites], [1, 3], "one new client, however its name is capitalised");
  assert.deepEqual([await count("clients"), await count("sites")], before, "a preview saves nothing");

  const r = await importRows(rows);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([await count("clients"), await count("sites")], [before[0]! + 1, before[1]! + 3]);
  assert.deepEqual(await sitesOf(a), ["Dock 2", "Pier"]);
  assert.deepEqual(await sitesOf(b), ["North", "South"], "both rows went to the one new client");
  const ids = r.body.rows.map((x: { siteId: string }) => x.siteId);
  assert.ok(ids.every((x: unknown) => typeof x === "string"), "every row says which site it is");
  const actions = (await db.app.query<{ action: string; details: { via?: string } }>(
    "SELECT action, details FROM audit_log WHERE actor_id = $1 AND action IN ('client.create', 'site.create', 'fleet.import') ORDER BY seq", [ada.id])).rows;
  // In the order of the rows: Harbour's new Dock 2, then the new Inland client and its two sites, then the import's own entry.
  assert.deepEqual(actions.map(x => x.action), ["site.create", "client.create", "site.create", "site.create", "fleet.import"]);
  assert.ok(actions.slice(0, 4).every(x => x.details.via === "import"));

  // The same list again creates nothing, and says so; extended by one row, only that row is created.
  const again = await importRows(rows);
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error, "nothing_to_import");
  const more = await importRows([...rows, { client: b, site: "East" }]);
  assert.equal(more.status, 200, JSON.stringify(more.body));
  assert.deepEqual(await sitesOf(b), ["East", "North", "South"]);
});

test("only an Admin imports, with a code for exactly these rows; a repeated row, a demo client or a hostile body changes nothing", async () => {
  const c = `Coastal ${tag()}`;
  const rows = [{ client: c, site: "One" }, { client: c, site: "Two" }];
  const before = [await count("clients"), await count("sites")];
  assert.equal((await preview(rows, tier2)).status, 403);
  assert.equal((await importRows(rows, tier2)).status, 403, "Tier 2");
  assert.equal((await importRows(rows, ada, [rows[0]!])).status, 403, "a code confirmed for one row does not import two");
  assert.equal((await call("POST", "/api/admin/import", { rows }, ada)).status, 403, "no code");
  const twice = await importRows([...rows, { client: c.toLowerCase(), site: "one" }]);
  assert.deepEqual([twice.status, twice.body.error], [400, "duplicate_row"]);
  const demo = randomUUID(), demoName = `Demo ${tag()}`;
  await db.app.query("INSERT INTO clients (id, name, demo) VALUES ($1, $2, 1)", [demo, demoName]);
  const intoDemo = await importRows([...rows, { client: demoName, site: "New" }]);
  assert.deepEqual([intoDemo.status, intoDemo.body.error], [409, "demo_client"]);
  for (const bad of [[], [{ client: c }], [{ client: " padded", site: "x" }], [{ client: "<script>", site: "x" }], [{ client: c, site: "x", cabinets: 3 }],
    [{ client: "a\u0000b", site: "x" }], [{ client: "x".repeat(129), site: "x" }], Array.from({ length: 201 }, (_, i) => ({ client: c, site: `S${i}` }))])
    assert.equal((await call("POST", "/api/admin/import/preview", { rows: bad }, ada)).status, 400, JSON.stringify(bad).slice(0, 80));
  assert.deepEqual([await count("clients"), await count("sites")], [before[0]! + 1, before[1]!], "only the demo client inserted by the test");
});

test("an import is all or nothing: a row that fails leaves none of the others created", async () => {
  const d = `Atomic ${tag()}`;
  const before = [await count("clients"), await count("sites")];
  // A site insert the database refuses partway through the list (a trigger the test adds as the owner), after the client and the first
  // site were inserted in the same transaction.
  await asOwner(db, c => c.query(`CREATE TRIGGER test_import_fail ON sites AFTER INSERT AS
    IF EXISTS (SELECT 1 FROM inserted WHERE name = N'Breaks') THROW 50001, 'refused by the test', 1;`));
  try {
    const failed = await importRows([{ client: d, site: "Fine" }, { client: d, site: "Breaks" }]);
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
  } finally {
    await asOwner(db, c => c.query("DROP TRIGGER test_import_fail"));
  }
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM clients WHERE name = $1", [d])).rows[0]!.n), 0, "the client was not kept");
  assert.deepEqual([await count("clients"), await count("sites")], before, "nor the first row's site");
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'client.create' AND details LIKE $1", [`%${d}%`])).rows[0]!.n), 0, "nor its audit entry");
});

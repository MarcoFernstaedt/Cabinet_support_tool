// Incident records in the console API (docs/platform/archive/diagnostic-engine-execution.md, "The foundation in detail", item 6): read only,
// Tier 1 and up, always within one cabinet; people shown by name, never by id; a record of another cabinet is not found through this
// one; hostile query strings are refused by the contract.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { appendStep, linkIncident, openIncident } from "../src/services/incidents.js";
import { ConsoleHarness } from "./console-harness.js";
import { createTestDatabase, type TestDatabase, startFeed } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);

test.before(async () => {
  db = await createTestDatabase();
  stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: "https://console.test", stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

async function cabinet(name: string): Promise<string> {
  const [client, site, id] = [randomUUID(), randomUUID(), randomUUID()];
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Client ${randomBytes(3).toString("hex")}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'satellite', 'active')", [id, site, name]);
  return id;
}

test("Tier 1 sees a cabinet's incidents newest first and each one's steps in order, with people named", async () => {
  const me = await h.account("tier1"), approver = await h.account("tier2");
  const cab = await cabinet("EXAM 1");
  const older = await openIncident(db.app, { cabinetId: cab, symptom: "Slow logins", by: { kind: "user", userId: me.id } });
  await appendStep(db.app, older, { kind: "close", summary: "Went away after a restart", result: "resolved" }, { kind: "user", userId: me.id });
  await new Promise(r => setTimeout(r, 20));
  const id = await openIncident(db.app, { cabinetId: cab, symptom: "The fingerprint scanner is not answering", module: { id: "cabinet-scanner", version: 1 }, by: { kind: "system", name: "engine" } });
  await appendStep(db.app, id, { kind: "proposed_repair", summary: "Restart the scanner's service" }, { kind: "system", name: "engine" });
  await appendStep(db.app, id, { kind: "approval", summary: "Approved" }, { kind: "user", userId: approver.id });
  const alertId = randomUUID();
  await db.app.query("INSERT INTO alerts (id, cabinet_id, severity, signature, title, first_seen, last_seen) VALUES ($1, $2, 'major', $3, 'Scanner offline', SYSUTCDATETIME(), SYSUTCDATETIME())", [alertId, cab, `sig-${alertId}`]);
  await linkIncident(db.app, id, "alert", alertId, { kind: "user", userId: me.id });

  const list = await h.call("GET", `/api/cabinets/${cab}/incidents`, undefined, me);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.map((i: { id: string }) => i.id), [id, older]);
  assert.deepEqual(list.body[0].openedBy, { kind: "system", name: "engine" });
  assert.deepEqual(list.body[1].openedBy, { kind: "user", name: `Test ${me.username}` });
  assert.equal(list.body[1].state, "resolved");
  assert.equal((await h.call("GET", `/api/cabinets/${cab}/incidents?limit=1`, undefined, me)).body.length, 1);

  const one = await h.call("GET", `/api/cabinets/${cab}/incidents/${id}`, undefined, me);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.steps.map((s: { kind: string }) => s.kind), ["symptom", "proposed_repair", "approval"]);
  assert.deepEqual(one.body.steps[2].actor, { kind: "user", name: `Test ${approver.username}` });
  assert.deepEqual(one.body.links.map((l: { kind: string; refId: string }) => [l.kind, l.refId]), [["alert", alertId]]);
  // No user id reaches the console, only names.
  for (const u of [me.id, approver.id]) assert.ok(!JSON.stringify(one.body).includes(u) && !JSON.stringify(list.body).includes(u));
});

test("an incident is only found through its own cabinet; unknown and malformed ids are not found", async () => {
  const me = await h.account("tier1");
  const [mine, other] = [await cabinet("MINE"), await cabinet("OTHER")];
  const id = await openIncident(db.app, { cabinetId: mine, symptom: "Drawer not opening", by: { kind: "user", userId: me.id } });
  assert.equal((await h.call("GET", `/api/cabinets/${other}/incidents/${id}`, undefined, me)).status, 404);
  assert.equal((await h.call("GET", `/api/cabinets/${mine}/incidents/${randomUUID()}`, undefined, me)).status, 404);
  assert.equal((await h.call("GET", `/api/cabinets/${mine}/incidents/not-an-id`, undefined, me)).status, 404);
  assert.equal((await h.call("GET", `/api/cabinets/${randomUUID()}/incidents`, undefined, me)).status, 404);
  assert.deepEqual((await h.call("GET", `/api/cabinets/${other}/incidents`, undefined, me)).body, []);
});

test("signed out is refused, hostile query strings are refused by the contract, and nothing can be written", async () => {
  const me = await h.account("tier1");
  const cab = await cabinet("EXAM 2");
  assert.equal((await h.call("GET", `/api/cabinets/${cab}/incidents`, undefined)).status, 401);
  for (const q of ["limit=0", "limit=201", "limit=10;DROP%20TABLE%20incidents", "limit=abc", "cabinetId=x", "limit=1&limit=2"])
    assert.equal((await h.call("GET", `/api/cabinets/${cab}/incidents?${q}`, undefined, me)).status, 400, q);
  const id = await openIncident(db.app, { cabinetId: cab, symptom: "Read only", by: { kind: "user", userId: me.id } });
  for (const [method, url] of [["POST", `/api/cabinets/${cab}/incidents`], ["POST", `/api/cabinets/${cab}/incidents/${id}`], ["PUT", `/api/cabinets/${cab}/incidents/${id}`]] as const)
    assert.equal((await h.call(method, url, { kind: "note", summary: "x" }, me)).status, 404, `${method} ${url}`);
});

test("the fleet's open incidents for triage: only open ones on active cabinets, most recently changed first, by client, with their last step", async () => {
  const me = await h.account("tier1");
  const engine = { kind: "system", name: "diagnosis" } as const;
  const [a, b, gone] = [await cabinet("TRIAGE A"), await cabinet("TRIAGE B"), await cabinet("TRIAGE GONE")];
  const older = await openIncident(db.app, { cabinetId: a, symptom: "The gateway does not answer", module: { id: "network-diagnosis", version: 1 }, by: engine });
  const newer = await openIncident(db.app, { cabinetId: b, symptom: "Drive C: is failing", module: { id: "cabinet-storage", version: 1 }, by: engine });
  await appendStep(db.app, newer, { kind: "evidence", summary: "The cabinet diagnosis found 1 problem: Drive C: is failing" }, engine);
  const closed = await openIncident(db.app, { cabinetId: a, symptom: "Closed one", by: engine });
  await appendStep(db.app, closed, { kind: "close", result: "resolved", summary: "Fixed" }, engine);
  await openIncident(db.app, { cabinetId: gone, symptom: "On a removed cabinet", by: engine });
  await db.app.query("UPDATE cabinets SET status = 'removed' WHERE id = $1", [gone]);
  // The order is by when each incident last changed; set those times apart so two changes in the same millisecond (updated_at keeps
  // milliseconds) cannot decide it by id instead (#146 review).
  await db.app.query("UPDATE incidents SET updated_at = DATEADD(minute, -2, SYSUTCDATETIME()) WHERE id = $1", [older]);
  await db.app.query("UPDATE incidents SET updated_at = DATEADD(minute, -1, SYSUTCDATETIME()) WHERE id = $1", [newer]);

  const all = await h.call("GET", "/api/incidents/open", undefined, me);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const mine = (all.body.incidents as { id: string }[]).filter(i => [older, newer, closed].includes(i.id));
  assert.deepEqual(mine.map(i => i.id), [newer, older], "open ones only, the one changed last first");
  assert.ok(!(all.body.incidents as { symptom: string }[]).some(i => i.symptom === "On a removed cabinet"), "a removed cabinet's incident is left out");
  const top = all.body.incidents.find((i: { id: string }) => i.id === newer);
  assert.equal(top.cabinet.name, "TRIAGE B");
  assert.equal(top.site.name, "North");
  assert.equal(top.steps, 2);
  assert.equal(top.lastStep.kind, "evidence");
  assert.deepEqual(top.module, { id: "cabinet-storage", version: 1 });

  // One client: only that client's cabinets.
  const clientOfB = (await db.app.query<{ client_id: string }>("SELECT s.client_id FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [b])).rows[0]!.client_id.toLowerCase();
  const one = await h.call("GET", `/api/incidents/open?clientId=${clientOfB}`, undefined, me);
  assert.deepEqual((one.body.incidents as { id: string }[]).map(i => i.id), [newer]);
  assert.equal((await h.call("GET", "/api/incidents/open?limit=1", undefined, me)).body.incidents.length, 1);

  // Signed out, hostile query strings, and writes.
  assert.equal((await h.call("GET", "/api/incidents/open", undefined)).status, 401);
  for (const q of ["limit=0", "limit=201", "clientId=1%20OR%201%3D1", "clientId=x", "cabinetId=x", "limit=1&limit=2", "clientId[]=a"])
    assert.equal((await h.call("GET", `/api/incidents/open?${q}`, undefined, me)).status, 400, q);
  assert.equal((await h.call("POST", "/api/incidents/open", {}, me)).status, 404);
});

// Known fixes (docs/spec/16-network-troubleshooting.md): what solved a problem is saved with the cabinet's environment, shown when the same
// problem is looked up again, matched exactly (never by pattern), and every request is checked.
// several, or a whole site, what it finds from the baseline, and the fixes: one cabinet with an authenticator code, many with
// the password, each checked by reading the settings back. The simulated cabinets keep their own network state, so a fix
// really changes what the next check sees.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { enableDemo } from "../src/demo/demo.js";
import { ConsoleHarness, ORIGIN, type Role } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));

const h = new ConsoleHarness(secrets);
const account = (role: Role) => h.account(role);
const call = h.call.bind(h);
const codeToken = h.codeToken.bind(h);
const cab = async (name: string) => (await db.app.query<{ id: string; site_id: string }>("SELECT id, site_id FROM cabinets WHERE name = $1 AND demo_scenario IS NOT NULL", [name])).rows[0]!;


test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  const owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

test("a member's fix waits for approval, then is shown to everyone; an Admin or a granted Tier 2 decides", async () => {
  const t1 = await account("tier1"), other = await account("tier1"), t2 = await account("tier2"), boss = await account("admin");
  const lab = (await cab("Operating Room")).id, elsewhere = (await cab("Exam Room 1")).id;
  const made = await call("POST", "/api/known-fixes", { title: "Failing patch cable", solution: "Swapped the patch cable and moved the switch port.", symptom: { kind: "finding", key: "obs-ping-loss" }, cabinetId: lab }, t1);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.status, "pending");
  assert.equal(made.body.environment.role, "satellite");
  assert.equal(made.body.environment.site, "Midtown Manhattan");
  assert.equal(made.body.environment.network, null, "no diagnosis has been run, so no network was read");

  // Only its submitter sees it, marked as waiting.
  const mine = await call("GET", `/api/known-fixes?findingKey=obs-ping-loss&cabinetId=${elsewhere}`, undefined, t1);
  assert.equal(mine.body.fixes.length, 1);
  assert.equal(mine.body.fixes[0].status, "pending");
  assert.equal((await call("GET", "/api/known-fixes?findingKey=obs-ping-loss", undefined, other)).body.fixes.length, 0, "not shown to anyone else yet");
  assert.equal((await call("GET", "/api/known-fixes?findingKey=obs-ping-loss", undefined, t2)).body.fixes.length, 0, "not even to a Tier 2 until decided");

  // Who may review: not a member, not a Tier 2 without the grant.
  assert.deepEqual((await call("GET", "/api/known-fixes/summary", undefined, t1)).body, { canApprove: false, pending: 0 });
  assert.equal((await call("GET", "/api/known-fixes/review", undefined, t1)).status, 403);
  assert.equal((await call("GET", "/api/known-fixes/review", undefined, t2)).status, 403);
  assert.equal((await call("POST", `/api/known-fixes/${made.body.id}/approve`, {}, t2)).status, 403);
  assert.equal((await call("POST", `/api/known-fixes/${made.body.id}/approve`, {}, t1)).status, 403, "never the submitter's own say");

  // The Admin sees it waiting, with its environment and who sent it.
  assert.deepEqual((await call("GET", "/api/known-fixes/summary", undefined, boss)).body, { canApprove: true, pending: 2 }); // the demo's teammate has one waiting already
  const queue = (await call("GET", "/api/known-fixes/review", undefined, boss)).body;
  assert.equal(queue.pending.length, 2);
  const ours = queue.pending.find((f: { id: string }) => f.id === made.body.id);
  assert.match(ours.savedBy, /tier1/);
  assert.ok(queue.pending.some((f: { savedBy: string }) => f.savedBy.startsWith("Priya")));

  // Granting a Tier 2 the permission (an Admin's step-up change) lets them approve.
  const grant = { canApproveFixes: true };
  const granted = await call("PUT", `/api/admin/users/${t2.id}`, { ...grant, stepUpToken: await codeToken(boss, "user.update", t2.id, grant) }, boss);
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  const t2again = { ...t2 }; // the same session: the permission is read on each request
  assert.deepEqual((await call("GET", "/api/known-fixes/summary", undefined, t2again)).body, { canApprove: true, pending: 2 });
  const approved = await call("POST", `/api/known-fixes/${made.body.id}/approve`, {}, t2again);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, "approved");
  assert.equal((await call("POST", `/api/known-fixes/${made.body.id}/approve`, {}, boss)).status, 409, "decided once");

  // Now everyone sees it, beside the other cabinet's environment.
  const found = await call("GET", `/api/known-fixes?findingKey=obs-ping-loss&cabinetId=${elsewhere}`, undefined, other);
  assert.equal(found.body.fixes.length, 1);
  assert.equal(found.body.fixes[0].solution, "Swapped the patch cable and moved the switch port.");
  assert.equal(found.body.now.site, "Midtown Manhattan");
  assert.equal((await call("GET", "/api/known-fixes?findingKey=obs-arp", undefined, t1)).body.fixes.length, 0, "exact key only");
  assert.equal((await call("GET", "/api/known-fixes?findingKey=obs", undefined, t1)).body.fixes.length, 0, "never a prefix or pattern");

  // A Tier 2 who is demoted loses it at once; the Admin's own submission needs no approval.
  const adminFix = await call("POST", "/api/known-fixes", { title: "Own", solution: "Fixed.", symptom: { kind: "finding", key: "obs-arp" }, cabinetId: lab }, boss);
  assert.equal(adminFix.body.status, "approved");

  // A rejection carries a reason only its submitter sees (and the Admin).
  const second = await call("POST", "/api/known-fixes", { title: "Vague", solution: "Did stuff.", symptom: { kind: "finding", key: "obs-mtu" }, cabinetId: lab }, t1);
  const rejected = await call("POST", `/api/known-fixes/${second.body.id}/reject`, { reason: "Say which port you changed." }, boss);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, "rejected");
  assert.equal((await call("GET", "/api/known-fixes?findingKey=obs-mtu", undefined, t1)).body.fixes[0].reviewNote, "Say which port you changed.");
  assert.equal((await call("GET", "/api/known-fixes?findingKey=obs-mtu", undefined, other)).body.fixes.length, 0);
  assert.equal((await call("POST", `/api/known-fixes/${second.body.id}/reject`, { reason: "x\u0000" }, boss)).status, 400);
  assert.equal((await call("POST", `/api/known-fixes/${second.body.id}/approve`, {}, boss)).status, 409, "a rejected fix is not revived by approving it");

  // Removal stays Tier 2 and up; a member cannot.
  assert.equal((await call("POST", `/api/known-fixes/${made.body.id}/remove`, {}, t1)).status, 403);
  assert.equal((await call("POST", `/api/known-fixes/${made.body.id}/remove`, {}, t2)).status, 200);
  assert.equal((await call("GET", "/api/known-fixes?findingKey=obs-ping-loss", undefined, t1)).body.fixes.length, 0);
  const audited = (await db.app.query("SELECT action FROM audit_log WHERE action LIKE 'known_fix.%' ORDER BY seq")).rows.map(r => r.action);
  assert.deepEqual(audited, ["known_fix.save", "known_fix.save", "known_fix.approve", "known_fix.save", "known_fix.save", "known_fix.reject", "known_fix.remove"]);
});

test("a diagnosis that finds a problem somebody has solved counts the fix as shown", async () => {
  const t1 = await account("tier1");
  const sync = await cab("Midtown Sync");
  const boss = await account("admin");
  await call("POST", "/api/known-fixes", { title: "Sync firewall", solution: "Applied the client policy.", symptom: { kind: "finding", key: "sync-firewall" }, cabinetId: sync.id }, boss);
  const started = await call("POST", `/api/cabinets/${(await cab("Exam Room 1")).id}/diagnose/network`, {}, t1);
  assert.equal(started.status, 202);
  for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    if ((await call("GET", `/api/diagnoses/${started.body.diagnosisId}`, undefined, t1)).body.state !== "running") break;
  }
  assert.equal(typeof (await call("GET", "/api/known-fixes?findingKey=sync-firewall", undefined, t1)).body.fixes[0].seenCount, "number");
});

test("hostile or malformed known fix requests are refused", async () => {
  const t1 = await account("tier1");
  const cabinetId = (await cab("Operating Room")).id;
  const good = { title: "x", solution: "y", symptom: { kind: "finding", key: "obs-arp" }, cabinetId };
  const bad: unknown[] = [
    { ...good, title: "" }, { ...good, solution: "" }, { ...good, solution: "a".repeat(2001) }, { ...good, solution: "bad\u0000text" },
    { ...good, symptom: { kind: "finding", key: "Obs-Arp" } }, { ...good, symptom: { kind: "finding", key: ".*" } }, { ...good, symptom: { kind: "finding", key: "a".repeat(60) } },
    { ...good, symptom: { kind: "issue", issueTypeId: "not-a-uuid" } }, { ...good, symptom: { kind: "other" } }, { ...good, cabinetId: "nope" },
    { ...good, environment: { role: "sync" } }, { ...good, extra: 1 }, { title: "x" }, "text", null, [],
  ];
  for (const body of bad) assert.equal((await call("POST", "/api/known-fixes", body, t1)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await call("POST", "/api/known-fixes", { ...good, cabinetId: randomUUID() }, t1)).status, 404);
  assert.equal((await call("POST", "/api/known-fixes", { ...good, symptom: { kind: "issue", issueTypeId: randomUUID() } }, t1)).status, 404);
  assert.equal((await call("POST", "/api/known-fixes", good)).status, 401, "signed in only");
  assert.equal((await call("GET", "/api/known-fixes?findingKey=%27%3B--", undefined, t1)).status, 400);
  assert.equal((await call("GET", "/api/known-fixes?other=1", undefined, t1)).status, 400);
});

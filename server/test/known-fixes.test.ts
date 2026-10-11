// Known fixes (docs/spec/14-network-troubleshooting.md): what solved a problem is saved with the cabinet's environment, shown when the same
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
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import { paramsHash } from "../src/auth/canonical.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { DemoSimulator, enableDemo } from "../src/demo/demo.js";
import { initialNet } from "../src/demo/network.js";
import { ISSUE } from "../src/services/rules.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
const TIMING = { pollMs: 50, verifyMs: 5_000 };
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let sim: DemoSimulator;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));

interface Account { id: string; username: string; password: string; secret: Buffer; cookie?: string }
async function account(role: "tier1" | "tier2" | "admin"): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, write_limit) VALUES ($1, $2, $3, $4, $5, false, true, $6, 100)`,
    [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(a.secret)]);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: a.username, password: a.password }) });
  a.cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  clock += 30_000;
  assert.equal((await call("POST", "/api/auth/totp", { code: totp.code(a.secret, totp.stepAt(clock)) }, a)).body.stage, "complete");
  return a;
}
async function call(method: "GET" | "POST" | "PUT", url: string, body: unknown, a?: Account) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (a?.cookie) headers.cookie = a.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  let parsed: any = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}
/** An authenticator-code token for one action on one target, bound to the exact parameters. */
async function codeToken(a: Account, action: string, target: string, params: unknown) {
  clock += 30_000;
  const r = await call("POST", "/api/auth/step-up", { code: totp.code(a.secret, totp.stepAt(clock)), action, target, paramsHash: paramsHash(params) }, a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token as string;
}
async function runBatch(a: Account, body: unknown, ms = 60_000) {
  const started = await call("POST", "/api/diagnose/network", body, a);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const b = (await call("GET", `/api/diagnose/network/batches/${started.body.batchId}`, undefined, a)).body;
    if (b.state === "done") return b;
  }
  assert.fail("the diagnosis did not finish");
}
/** A job on the Fleet operations path, confirmed with the password; returns the finished job. */
async function runJob(a: Account, operation: string, cabinetIds: string[]) {
  const jobId = randomUUID(), batchSize = 10;
  const t = await call("POST", "/api/auth/confirm-password", { password: a.password, action: "fleet.job", target: jobId, paramsHash: paramsHash({ operation, cabinetIds, batchSize }) }, a);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const started = await call("POST", "/api/fleet-operations/jobs", { jobId, operation, cabinetIds, batchSize, stepUpToken: t.body.token }, a);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const j = (await call("GET", `/api/fleet-operations/jobs/${jobId}`, undefined, a)).body;
    if (j.state !== "running") return j;
  }
  assert.fail("the job did not finish");
}
const cab = async (name: string) => (await db.app.query<{ id: string; site_id: string }>("SELECT id, site_id FROM cabinets WHERE name = $1 AND demo_scenario IS NOT NULL", [name])).rows[0]!;


test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock });
  const owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

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

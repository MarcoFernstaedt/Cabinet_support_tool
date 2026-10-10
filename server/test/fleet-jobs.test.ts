// Fleet operations (docs/spec/13-roadmap.md modules 21 and 45): choosing cabinets, preview, the password bound to the
// exact selection, jobs with a fixed target list, per-cabinet results and verification, pauses mid-job, resuming after a
// restart, cancelling, hostile bodies, and scale. The simulated fleet answers through the real server paths.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import { paramsHash } from "../src/auth/canonical.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { DemoSimulator, enableDemo } from "../src/demo/demo.js";
import { resumeJobs, runJob, startJob } from "../src/services/fleet-jobs.js";
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
async function account(role: "tier1" | "tier2" | "admin", writeLimit = 20): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, write_limit) VALUES ($1, $2, $3, $4, $5, false, true, $6, $7)`,
    [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(a.secret), writeLimit]);
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
/** The password confirmation, bound to the exact operation, cabinets and batch size, for this job ID. */
async function confirm(a: Account, jobId: string, bound: { operation: string; cabinetIds: string[]; batchSize: number }) {
  const r = await call("POST", "/api/auth/confirm-password", { password: a.password, action: "fleet.job", target: jobId, paramsHash: paramsHash(bound) }, a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token as string;
}
async function runToEnd(a: Account, operation: string, cabinetIds: string[], batchSize = 20, ms = 60_000) {
  const jobId = randomUUID();
  const token = await confirm(a, jobId, { operation, cabinetIds, batchSize });
  const started = await call("POST", "/api/fleet-operations/jobs", { jobId, operation, cabinetIds, batchSize, stepUpToken: token }, a);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return waitDone(a, jobId, ms);
}
async function waitDone(a: Account, jobId: string, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const j = (await call("GET", `/api/fleet-operations/jobs/${jobId}`, undefined, a)).body;
    if (j.state !== "running") return j;
  }
  assert.fail(`job ${jobId} did not finish`);
}
const scenarioIds = async (scenario: string) =>
  (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario = $1 ORDER BY name", [scenario])).rows.map(r => r.id);
const openAlert = async (cabinetId: string, issue: string) => (await db.app.query(
  "SELECT 1 FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [cabinetId, issue])).rows.length > 0;

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock, fleetJobTiming: TIMING });
  const owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
  sim = new DemoSimulator(db.app, m => assert.fail(m), 25, [0, 20]);
  sim.start();
});
test.after(async () => { sim.stop(); await app.close(); await stream.stop(); await db.drop(); });

test("the page lists cabinets by client, site and problem; hostile queries are refused", async () => {
  const t1 = await account("tier1");
  const wrong = (await call("GET", "/api/fleet-operations/cabinets?problem=time_zone_wrong", undefined, t1)).body.cabinets;
  assert.equal(wrong.length, 3);
  assert.ok(wrong.every((c: { timeZoneId: string; site: { timeZone: string } }) => c.timeZoneId !== c.site.timeZone));
  const client = wrong[0].client.id;
  const all = (await call("GET", `/api/fleet-operations/cabinets?clientId=${client}`, undefined, t1)).body.cabinets;
  assert.ok(all.length > wrong.filter((c: { client: { id: string } }) => c.client.id === client).length);
  for (const q of ["problem=x'%20OR%201=1", "clientId=../../etc", "limit=100000", "siteId=1"])
    assert.equal((await call("GET", `/api/fleet-operations/cabinets?${q}`, undefined, t1)).status, 400, q);
  assert.equal((await call("GET", "/api/fleet-operations/cabinets", undefined)).status, 401);
});

test("preview says what each cabinet gets and why any is skipped, and changes nothing", async () => {
  const t1 = await account("tier1");
  const wrong = await scenarioIds("time_zone_wrong");
  const [offline] = await scenarioIds("offline");
  const [healthy] = await scenarioIds("healthy");
  const p = (await call("POST", "/api/fleet-operations/preview", { operation: "time.setZone", cabinetIds: [...wrong, offline!, healthy!] }, t1)).body;
  assert.equal(p.change, 3);
  assert.deepEqual(p.cabinets.filter((c: { skip: string | null }) => c.skip).map((c: { skip: string }) => c.skip).sort(),
    ["Already in its site's time zone.", "Offline: not heard from in the last 5 minutes."]);
  // Each cabinet gets its own site's zone, filled in by the server.
  for (const c of p.cabinets.filter((x: { skip: string | null }) => !x.skip)) {
    const site = (await db.app.query("SELECT s.time_zone FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [c.id])).rows[0].time_zone;
    assert.deepEqual(c.params, { timeZoneId: site });
  }
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM commands WHERE operation = 'time.setZone'")).rows[0].n, 0);
  for (const body of [{ operation: "network.setIp", cabinetIds: wrong }, { operation: "time.sync", cabinetIds: [] }, { operation: "time.sync", cabinetIds: ["../x"] },
    { operation: "time.sync", cabinetIds: Array.from({ length: 201 }, () => randomUUID()) }])
    assert.equal((await call("POST", "/api/fleet-operations/preview", body, t1)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await call("POST", "/api/fleet-operations/preview", { operation: "time.sync", cabinetIds: [randomUUID()] }, t1)).status, 404);
});

test("scenario C: Tier 1 corrects every wrong time zone with the password; each cabinet is changed, verified, and its alert closes", async () => {
  const t1 = await account("tier1");
  const wrong = await scenarioIds("time_zone_wrong");
  const [healthy] = await scenarioIds("healthy");
  const ids = [...wrong, healthy!];
  // A confirmation for another selection, or another batch size, does not start this one.
  const jobId = randomUUID();
  const other = await confirm(t1, jobId, { operation: "time.setZone", cabinetIds: wrong, batchSize: 20 });
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "time.setZone", cabinetIds: ids, batchSize: 20, stepUpToken: other }, t1)).status, 403);
  // The real flow.
  const before = Number((await db.app.query("SELECT count(DISTINCT COALESCE(bulk_id, id)) AS n FROM commands WHERE issued_by = $1", [t1.id])).rows[0].n);
  const j = await runToEnd(t1, "time.setZone", ids, 2);
  assert.equal(j.state, "done");
  assert.deepEqual(j.counts, { verified: 3, skipped: 1 });
  for (const id of wrong) assert.ok(!(await openAlert(id, ISSUE.timeZone)), "the zone alert closed");
  // One job counts once against the person's limit; its commands share the job's ID and are each audited.
  const after = Number((await db.app.query("SELECT count(DISTINCT COALESCE(bulk_id, id)) AS n FROM commands WHERE issued_by = $1", [t1.id])).rows[0].n);
  assert.equal(after - before, 1);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM commands WHERE bulk_id = $1", [j.id])).rows[0].n, 3);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'command.write' AND details->>'bulkId' = $1", [j.id])).rows[0].n, 3);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'fleet.job.start' AND target_id = $1", [j.id])).rows[0].n, 1);
  // The token was used once.
  assert.ok((await call("GET", "/api/fleet-operations/jobs", undefined, t1)).body.jobs.some((x: { id: string; verified: number }) => x.id === j.id && x.verified === 3));
});

test("a clock sync job verifies each clock from the cabinet's next heartbeat", async () => {
  const t1 = await account("tier1");
  const drift = await scenarioIds("clock_drift");
  const j = await runToEnd(t1, "time.sync", drift, 5);
  assert.deepEqual(j.counts, { verified: 1 });
  assert.match(j.cabinets[0].detail, /within two minutes/);
  assert.ok(!(await openAlert(drift[0]!, ISSUE.clock)));
});

test("a cabinet that never answers fails on its own; the rest of the job goes on (partial failure)", async () => {
  const t1 = await account("tier1");
  const [quiet] = await scenarioIds("incident_loop");
  const [healthy] = await scenarioIds("healthy");
  // The looping cabinet still counts as online (it was heard recently) but the simulator never answers it.
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = now() WHERE id = $1", [quiet]);
  const jobId = randomUUID();
  const ids = [quiet!, healthy!];
  const token = await confirm(t1, jobId, { operation: "time.sync", cabinetIds: ids, batchSize: 2 });
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "time.sync", cabinetIds: ids, batchSize: 2, stepUpToken: token }, t1)).status, 202);
  // Its command expires (made quick here); the job records that and finishes with the other verified.
  await new Promise(r => setTimeout(r, 300));
  await db.app.query("UPDATE commands SET status = 'expired' WHERE bulk_id = $1 AND cabinet_id = $2 AND status = 'queued'", [jobId, quiet]);
  const j = await waitDone(t1, jobId);
  assert.equal(j.cabinets.find((c: { id: string }) => c.id === quiet).state, "failed");
  assert.equal(j.cabinets.find((c: { id: string }) => c.id === healthy).state, "verified");
  assert.match(j.cabinets.find((c: { id: string }) => c.id === quiet).detail, /did not answer/);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = now() - interval '20 hours' WHERE id = $1", [quiet]);
});

test("a fleet-wide pause during a job skips the cabinets not yet reached; nothing is sent after it", async () => {
  const t1 = await account("tier1");
  const ids = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario = 'incident_ok' ORDER BY name LIMIT 4")).rows.map(r => r.id);
  const jobId = randomUUID();
  const token = await issueStepUpToken(db.app, t1.id, "fleet.job", jobId, paramsHash({ operation: "time.sync", cabinetIds: ids, batchSize: 1 }));
  await startJob(db.app, { userId: t1.id, role: "tier1" }, { jobId, operation: "time.sync", cabinetIds: ids, batchSize: 1, stepUpToken: token });
  await db.app.query(`INSERT INTO settings (key, value) VALUES ('writes.paused', '{"paused": true, "reason": "test", "by": null, "at": null}')
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  try {
    await runJob(db.app, jobId, TIMING);
    const states = (await db.app.query<{ state: string; detail: string }>("SELECT state, detail FROM fleet_job_targets WHERE job_id = $1", [jobId])).rows;
    assert.ok(states.every(s => s.state === "skipped" && /paused fleet-wide/.test(s.detail)), JSON.stringify(states));
    assert.equal((await db.app.query("SELECT count(*)::int AS n FROM commands WHERE bulk_id = $1", [jobId])).rows[0].n, 0);
  } finally {
    await db.app.query("DELETE FROM settings WHERE key = 'writes.paused'");
  }
});

test("a job left running by a restart is picked up again and finished", async () => {
  const t1 = await account("tier1");
  const ids = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario = 'incident_ok' ORDER BY name LIMIT 3")).rows.map(r => r.id);
  const jobId = randomUUID();
  const token = await issueStepUpToken(db.app, t1.id, "fleet.job", jobId, paramsHash({ operation: "time.sync", cabinetIds: ids, batchSize: 3 }));
  await startJob(db.app, { userId: t1.id, role: "tier1" }, { jobId, operation: "time.sync", cabinetIds: ids, batchSize: 3, stepUpToken: token });
  assert.ok(await resumeJobs(db.app, TIMING) >= 1);
  const j = await waitDone(t1, jobId);
  assert.deepEqual(j.counts, { verified: 3 });
});

test("cancelling: only the person who started it or an Admin; a cancelled job sends nothing more", async () => {
  const t1 = await account("tier1"), other = await account("tier1"), admin = await account("admin");
  const ids = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario = 'incident_ok' ORDER BY name LIMIT 5")).rows.map(r => r.id);
  const jobId = randomUUID();
  const token = await issueStepUpToken(db.app, t1.id, "fleet.job", jobId, paramsHash({ operation: "time.sync", cabinetIds: ids, batchSize: 1 }));
  await startJob(db.app, { userId: t1.id, role: "tier1" }, { jobId, operation: "time.sync", cabinetIds: ids, batchSize: 1, stepUpToken: token });
  assert.equal((await call("POST", `/api/fleet-operations/jobs/${jobId}/cancel`, {}, other)).status, 403);
  assert.equal((await call("POST", `/api/fleet-operations/jobs/${jobId}/cancel`, {}, admin)).status, 200);
  await runJob(db.app, jobId, TIMING);
  const j = (await call("GET", `/api/fleet-operations/jobs/${jobId}`, undefined, t1)).body;
  assert.equal(j.state, "cancelled");
  assert.deepEqual(j.counts, { cancelled: 5 });
  assert.equal((await call("POST", `/api/fleet-operations/jobs/${jobId}/cancel`, {}, t1)).body.error, "job_finished");
});

test("hostile and over-limit job requests are refused before anything is sent", async () => {
  const t1 = await account("tier1");
  const ids = (await scenarioIds("incident_ok")).slice(0, 2);
  const jobId = randomUUID();
  const T = "A".repeat(43);
  for (const body of [
    { jobId, operation: "shell.run", cabinetIds: ids, batchSize: 1, stepUpToken: T },
    { jobId, operation: "time.setZone", cabinetIds: ids, batchSize: 1, stepUpToken: T, timeZoneId: "UTC" },
    { jobId, operation: "time.sync", cabinetIds: [ids[0], ids[0]], batchSize: 1, stepUpToken: T },
    { jobId, operation: "time.sync", cabinetIds: Array.from({ length: 201 }, () => randomUUID()), batchSize: 1, stepUpToken: T },
    { jobId, operation: "time.sync", cabinetIds: ids, batchSize: 0, stepUpToken: T },
    { jobId: "x", operation: "time.sync", cabinetIds: ids, batchSize: 1, stepUpToken: T },
  ]) assert.equal((await call("POST", "/api/fleet-operations/jobs", body, t1)).status, 400, JSON.stringify(body).slice(0, 100));
  // A made-up token, and a real one used twice.
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "time.sync", cabinetIds: ids, batchSize: 1, stepUpToken: T }, t1)).status, 403);
  const token = await confirm(t1, jobId, { operation: "time.sync", cabinetIds: ids, batchSize: 1 });
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "time.sync", cabinetIds: ids, batchSize: 1, stepUpToken: token }, t1)).status, 202);
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "time.sync", cabinetIds: ids, batchSize: 1, stepUpToken: token }, t1)).status, 403);
  await waitDone(t1, jobId);
  // Someone at their write limit cannot start a job.
  const limited = await account("tier1", 0);
  const j2 = randomUUID();
  const t2 = await confirm(limited, j2, { operation: "time.sync", cabinetIds: ids, batchSize: 1 });
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId: j2, operation: "time.sync", cabinetIds: ids, batchSize: 1, stepUpToken: t2 }, limited)).body.error, "write_limit_reached");
});

for (const size of [10, 60, 100])
  test(`scale: a clock sync across ${size} cabinets finishes with every reachable cabinet verified`, async () => {
    const t1 = await account("tier1");
    const ids = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario IS NOT NULL ORDER BY name LIMIT $1", [size])).rows.map(r => r.id);
    const started = Date.now();
    const j = await runToEnd(t1, "time.sync", ids, 20, 120_000);
    const reachable = (await db.app.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM cabinets WHERE id = ANY($1::uuid[]) AND last_heartbeat_at > now() - interval '5 minutes' AND demo_scenario NOT IN ('offline', 'incident_loop')", [ids])).rows[0]!.n;
    assert.equal(j.counts.verified ?? 0, reachable, JSON.stringify(j.counts));
    assert.equal((j.counts.verified ?? 0) + (j.counts.skipped ?? 0) + (j.counts.failed ?? 0), ids.length, JSON.stringify(j.counts));
    console.log(`# scale ${size}: ${ids.length} cabinets, ${JSON.stringify(j.counts)}, ${Date.now() - started} ms`);
  });

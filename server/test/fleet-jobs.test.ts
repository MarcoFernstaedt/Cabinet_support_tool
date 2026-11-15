// Fleet operations (docs/spec/13-roadmap.md modules 21 and 45): choosing cabinets, preview, the password bound to the
// exact selection, jobs with a fixed target list, per-cabinet results and verification, pauses mid-job, resuming after a
// restart, cancelling, hostile bodies, and scale. The simulated fleet answers through the real server paths.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import { paramsHash } from "../src/auth/canonical.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { DemoSimulator, enableDemo } from "../src/demo/demo.js";
import * as fleetJobs from "../src/services/fleet-jobs.js";
import { preview, resumeJobs, runJob, startJob } from "../src/services/fleet-jobs.js";
import { takeLeasedCommands } from "../src/services/commands.js";
import { takeLease } from "../src/services/job-lease.js";
import type { Pool, Tx } from "../src/db/db.js";
import { ISSUE } from "../src/services/rules.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
const TIMING = { pollMs: 50, verifyMs: 5_000 };
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
let sim: DemoSimulator;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));

interface Account { id: string; username: string; password: string; secret: Buffer; cookie?: string }
async function account(role: "tier1" | "tier2" | "admin", writeLimit = 20): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, write_limit) VALUES ($1, $2, $3, $4, $5, 0, 1, $6, $7)`,
    [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(a.secret), writeLimit]);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: a.username, password: a.password }) });
  a.cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  clock += 30_000;
  assert.equal((await call("POST", "/api/auth/totp", { code: totp.code(a.secret, totp.stepAt(clock)) }, a)).body.stage, "complete");
  return a;
}
const digests = new Map<string, string>();
async function call(method: "GET" | "POST" | "PUT", url: string, body: unknown, a?: Account) {
  if (url === "/api/fleet-operations/jobs" && body && typeof body === "object") {
    const b = body as { jobId: string; planDigest?: string };
    body = { planDigest: digests.get(b.jobId) ?? "0".repeat(64), ...b };
  }
  const headers: Record<string, string> = { origin: ORIGIN };
  if (a?.cookie) headers.cookie = a.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  let parsed: any = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}
/** The password confirmation, bound to the exact operation, cabinets and batch size, for this job ID. */
async function confirm(a: Account, jobId: string, bound: { operation: string; cabinetIds: string[]; batchSize: number }) {
  let planDigest = "0".repeat(64);
  try { planDigest = (await preview(db.app, { role: "admin" }, bound.operation as Parameters<typeof preview>[2], bound.cabinetIds)).planDigest; }
  catch (e) { assert.equal((e as { code?: string }).code, "one_site_only"); }
  digests.set(jobId, planDigest);
  const r = await call("POST", "/api/auth/confirm-password", { password: a.password, action: "fleet.job", target: jobId, paramsHash: paramsHash({ ...bound, planDigest }) }, a);
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
/** Cabinets of one site, online ones that answer (not a restart loop). */
const siteCabinets = async (siteId: string, n: number) =>
  (await db.app.query<{ id: string }>("SELECT TOP ($2) id FROM cabinets WHERE site_id = $1 AND demo_scenario NOT IN ('offline', 'incident_loop') ORDER BY name", [siteId, n])).rows.map(r => r.id);
/** A Harbor site with at least five cabinets that answer. */
const harborSite = async () => (await db.app.query<{ site_id: string }>("SELECT TOP (1) site_id FROM cabinets WHERE demo_scenario = 'incident_ok' GROUP BY site_id ORDER BY site_id")).rows[0]!.site_id;
const nySite = async () => (await db.app.query<{ id: string }>("SELECT s.id FROM sites s JOIN clients c ON c.id = s.client_id WHERE c.demo = 1 AND s.name LIKE 'New York%'")).rows[0]!.id;
const inSite = async (siteId: string, scenario: string) =>
  (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE site_id = $1 AND demo_scenario = $2 ORDER BY name", [siteId, scenario])).rows.map(r => r.id);
/** A site of n healthy simulated cabinets, for the scale tests (a job covers one site). */
async function bigSite(n: number): Promise<string> {
  const client = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM clients WHERE demo = 1")).rows[0]!.id;
  const site = randomUUID();
  await db.app.query("INSERT INTO sites (id, client_id, name, time_zone) VALUES ($1, $2, $3, 'Eastern Standard Time')", [site, client, `Scale ${n} ${site.slice(0, 4)}`]);
  await db.app.query(
    `INSERT INTO cabinets (id, site_id, name, role, status, hostname, serial_number, read_only, agent_version, uptime_seconds, demo_scenario, firewall_profiles, time_zone_id, clock_skew_seconds, last_heartbeat_at)
     SELECT NEWID(), $1, CONCAT('Scale ', g), 'satellite', 'active', CONCAT('SCALE-', SUBSTRING($3, 1, 4), '-', g), CONCAT('SC', g, SUBSTRING($3, 1, 4)), 0, '1.4.2', 86400, 'healthy',
            '{"domain": false, "private": false, "public": false}', 'Eastern Standard Time', 0.3, SYSUTCDATETIME()
       FROM (SELECT TOP ($2) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS g FROM sys.all_objects a CROSS JOIN sys.all_objects b) AS numbers`, [site, n, site]);
  return site;
}
const openAlert = async (cabinetId: string, issue: string) => (await db.app.query(
  "SELECT 1 FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [cabinetId, issue])).rows.length > 0;

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock, fleetJobTiming: TIMING });
  const owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
  sim = new DemoSimulator(db.app, m => assert.fail(m), 25, [0, 20]);
  sim.start();
});
test.after(async () => { sim.stop(); await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

test("the page lists cabinets by client, site and problem; hostile queries are refused", async () => {
  const t1 = await account("tier1");
  const wrong = (await call("GET", "/api/fleet-operations/cabinets?problem=time_zone_wrong", undefined, t1)).body.cabinets;
  assert.equal(wrong.length, 6, "three at New York, one each at Phoenix, San Diego and Austin");
  assert.ok(wrong.every((c: { timeZoneId: string; site: { timeZone: string } }) => c.timeZoneId !== c.site.timeZone));
  // Choosing a site narrows the list to it, and every row carries the address the cabinet last reported.
  const ny = (await call("GET", `/api/fleet-operations/cabinets?siteId=${await nySite()}`, undefined, t1)).body.cabinets;
  assert.equal(ny.length, 8);
  assert.ok(ny.every((c: { site: { id: string } }) => c.site.id === ny[0].site.id));
  assert.ok(ny.every((c: { ipv4: string | null }) => /^\d+\.\d+\.\d+\.\d+$/.test(c.ipv4 ?? "")), JSON.stringify(ny.map((c: { ipv4: string }) => c.ipv4)));
  assert.equal(ny.filter((c: { ipv4: string }) => c.ipv4.startsWith("192.168.1.")).length, 1, "Lab still has the fixed address from another network");
  const client = wrong[0].client.id;
  const all = (await call("GET", `/api/fleet-operations/cabinets?clientId=${client}`, undefined, t1)).body.cabinets;
  assert.ok(all.length > wrong.filter((c: { client: { id: string } }) => c.client.id === client).length);
  for (const q of ["problem=x'%20OR%201=1", "clientId=../../etc", "limit=100000", "siteId=1"])
    assert.equal((await call("GET", `/api/fleet-operations/cabinets?${q}`, undefined, t1)).status, 400, q);
  assert.equal((await call("GET", "/api/fleet-operations/cabinets", undefined)).status, 401);
});

test("preview says what each cabinet gets and why any is skipped, and changes nothing", async () => {
  const t1 = await account("tier1");
  const ny = await nySite();
  const wrong = await inSite(ny, "time_zone_wrong");
  const [healthy] = await inSite(ny, "healthy");
  const offline = (await inSite(ny, "net_static_wrong"))[0]!;
  // The demo simulator sends every simulated cabinet a heartbeat, except one whose scenario is "offline". Moving this one into that
  // scenario, and letting a sweep that already listed it finish, is what keeps it offline until the preview has read it.
  await db.app.query("UPDATE cabinets SET demo_scenario = 'offline' WHERE id = $1", [offline]);
  await sim.settled();
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -20, SYSUTCDATETIME()) WHERE id = $1", [offline]);
  // Cabinets from two sites are refused: a bulk change covers one site.
  const [elsewhere] = await scenarioIds("disk_failing");
  const two = await call("POST", "/api/fleet-operations/preview", { operation: "time.setZone", cabinetIds: [...wrong, elsewhere!] }, t1);
  assert.equal(two.status, 409);
  assert.equal(two.body.error, "one_site_only");
  const p = (await call("POST", "/api/fleet-operations/preview", { operation: "time.setZone", cabinetIds: [...wrong, offline, healthy!] }, t1)).body;
  assert.ok(p.cabinets.every((c: { ipv4: string | null }) => c.ipv4 !== null), "the preview shows each cabinet's address");
  assert.equal(p.change, 3);
  const skipOf = (id: string) => p.cabinets.find((c: { id: string }) => c.id === id)?.skip ?? null;
  assert.equal(skipOf(offline), "Offline: not heard from in the last 5 minutes.");
  assert.equal(skipOf(healthy!), "Already in its site's time zone.");
  assert.ok(wrong.every(id => skipOf(id) === null), "every cabinet in the wrong zone is changed");
  // Each cabinet gets its own site's zone, filled in by the server.
  for (const c of p.cabinets.filter((x: { skip: string | null }) => !x.skip)) {
    const site = (await db.app.query<{ time_zone: string | null }>("SELECT s.time_zone FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [c.id])).rows[0]!.time_zone;
    assert.deepEqual(c.params, { timeZoneId: site });
  }
  assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE operation = 'time.setZone'")).rows[0]!.n, 0);
  for (const body of [{ operation: "driver.uninstall", cabinetIds: wrong }, { operation: "time.sync", cabinetIds: [] }, { operation: "time.sync", cabinetIds: ["../x"] },
    { operation: "time.sync", cabinetIds: Array.from({ length: 201 }, () => randomUUID()) }])
    assert.equal((await call("POST", "/api/fleet-operations/preview", body, t1)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await call("POST", "/api/fleet-operations/preview", { operation: "time.sync", cabinetIds: [randomUUID()] }, t1)).status, 404);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME(), demo_scenario = 'net_static_wrong' WHERE id = $1", [offline]);
});

test("scenario C: Tier 1 corrects every wrong time zone with the password; each cabinet is changed, verified, and its alert closes", async () => {
  const t1 = await account("tier1");
  const ny = await nySite();
  const wrong = await inSite(ny, "time_zone_wrong");
  const [healthy] = await inSite(ny, "healthy");
  const ids = [...wrong, healthy!];
  // A confirmation for another selection, or another batch size, does not start this one.
  const jobId = randomUUID();
  const other = await confirm(t1, jobId, { operation: "time.setZone", cabinetIds: wrong, batchSize: 20 });
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "time.setZone", cabinetIds: ids, batchSize: 20, stepUpToken: other }, t1)).status, 403);
  // The real flow.
  const before = Number((await db.app.query<{ n: number }>("SELECT COUNT(DISTINCT COALESCE(bulk_id, id)) AS n FROM commands WHERE issued_by = $1", [t1.id])).rows[0]!.n);
  const j = await runToEnd(t1, "time.setZone", ids, 2);
  assert.equal(j.state, "done");
  assert.deepEqual(j.counts, { verified: 3, skipped: 1 });
  for (const id of wrong) assert.ok(!(await openAlert(id, ISSUE.timeZone)), "the zone alert closed");
  // One job counts once against the person's limit; its commands share the job's ID and are each audited.
  const after = Number((await db.app.query<{ n: number }>("SELECT COUNT(DISTINCT COALESCE(bulk_id, id)) AS n FROM commands WHERE issued_by = $1", [t1.id])).rows[0]!.n);
  assert.equal(after - before, 1);
  assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE bulk_id = $1", [j.id])).rows[0]!.n, 3);
  assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'command.write' AND JSON_VALUE(details, '$.bulkId') = $1", [j.id])).rows[0]!.n, 3);
  assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'fleet.job.start' AND target_id = $1", [j.id])).rows[0]!.n, 1);
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

test("a cabinet out of contact for the whole job is offline, not failed; the rest of the job goes on (partial failure, F18.R2)", async () => {
  const t1 = await account("tier1");
  const [quiet] = await scenarioIds("incident_loop");
  const quietSite = (await db.app.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [quiet])).rows[0]!.site_id;
  const [healthy] = await inSite(quietSite, "incident_ok");
  // The looping cabinet still counts as online (it was heard recently) but the simulator never answers it.
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [quiet]);
  const jobId = randomUUID();
  const ids = [quiet!, healthy!];
  const token = await confirm(t1, jobId, { operation: "time.sync", cabinetIds: ids, batchSize: 2 });
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "time.sync", cabinetIds: ids, batchSize: 2, stepUpToken: token }, t1)).status, 202);
  // Its command expires (made quick here); the job records that and finishes with the other verified.
  await new Promise(r => setTimeout(r, 300));
  await db.app.query("UPDATE commands SET status = 'expired' WHERE bulk_id = $1 AND cabinet_id = $2 AND status = 'queued'", [jobId, quiet]);
  const j = await waitDone(t1, jobId);
  assert.equal(j.cabinets.find((c: { id: string }) => c.id === quiet).state, "offline", "it never took the command");
  assert.equal(j.cabinets.find((c: { id: string }) => c.id === healthy).state, "verified");
  assert.match(j.cabinets.find((c: { id: string }) => c.id === quiet).detail, /out of contact and never took the command/);
  assert.deepEqual(j.counts, { offline: 1, verified: 1 });
  const recent = (await call("GET", "/api/fleet-operations/jobs", undefined, t1)).body;
  const listed = (Array.isArray(recent) ? recent : recent.jobs).find((x: { id: string }) => x.id === jobId);
  assert.equal(listed.problems, 1, "an offline cabinet counts as a problem in the list of jobs");
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -20, SYSUTCDATETIME()) WHERE id = $1", [quiet]);
});

test("a cabinet that took the command and never answered is failed, not offline: something may have been changed on it (F18.R2)", async () => {
  const t1 = await account("tier1");
  const [, quiet] = await scenarioIds("incident_loop");
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [quiet]);
  const jobId = randomUUID();
  const token = await confirm(t1, jobId, { operation: "time.sync", cabinetIds: [quiet!], batchSize: 1 });
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "time.sync", cabinetIds: [quiet!], batchSize: 1, stepUpToken: token }, t1)).status, 202);
  await new Promise(r => setTimeout(r, 300));
  await db.app.query("UPDATE commands SET status = 'expired', delivered_at = SYSUTCDATETIME() WHERE bulk_id = $1 AND cabinet_id = $2 AND status = 'queued'", [jobId, quiet]);
  const j = await waitDone(t1, jobId);
  assert.equal(j.cabinets[0].state, "failed");
  assert.match(j.cabinets[0].detail, /took the command but did not answer/);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -20, SYSUTCDATETIME()) WHERE id = $1", [quiet]);
});

test("a fleet-wide pause during a job skips the cabinets not yet reached; nothing is sent after it", async () => {
  const t1 = await account("tier1");
  const ids = await siteCabinets(await harborSite(), 4);
  const jobId = randomUUID();
  const planDigest = (await preview(db.app, { role: "tier1" }, "time.sync", ids)).planDigest;
  const token = await issueStepUpToken(db.app, t1.id, "fleet.job", jobId, paramsHash({ planDigest, operation: "time.sync", cabinetIds: ids, batchSize: 1 }));
  await startJob(db.app, { userId: t1.id, role: "tier1" }, { jobId, planDigest, operation: "time.sync", cabinetIds: ids, batchSize: 1, stepUpToken: token });
  await db.app.query(`DELETE FROM settings WHERE [key] = 'writes.paused';
                      INSERT INTO settings ([key], [value]) VALUES ('writes.paused', '{"paused": true, "reason": "test", "by": null, "at": null}')`);
  try {
    await runJob(db.app, jobId, TIMING);
    const states = (await db.app.query<{ state: string; detail: string }>("SELECT state, detail FROM fleet_job_targets WHERE job_id = $1", [jobId])).rows;
    assert.ok(states.every(s => s.state === "skipped" && /paused fleet-wide/.test(s.detail)), JSON.stringify(states));
    assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE bulk_id = $1", [jobId])).rows[0]!.n, 0);
  } finally {
    await db.app.query("DELETE FROM settings WHERE [key] = 'writes.paused'");
  }
});

test("a job left running by a restart is picked up again and finished", async () => {
  const t1 = await account("tier1");
  const ids = await siteCabinets(await harborSite(), 3);
  const jobId = randomUUID();
  const planDigest = (await preview(db.app, { role: "tier1" }, "time.sync", ids)).planDigest;
  const token = await issueStepUpToken(db.app, t1.id, "fleet.job", jobId, paramsHash({ planDigest, operation: "time.sync", cabinetIds: ids, batchSize: 3 }));
  await startJob(db.app, { userId: t1.id, role: "tier1" }, { jobId, planDigest, operation: "time.sync", cabinetIds: ids, batchSize: 3, stepUpToken: token });
  assert.ok(await resumeJobs(db.app, TIMING) >= 1);
  const j = await waitDone(t1, jobId);
  assert.deepEqual(j.counts, { verified: 3 });
});

test("cancelling: only the person who started it or an Admin; a cancelled job sends nothing more", async () => {
  const t1 = await account("tier1"), other = await account("tier1"), admin = await account("admin");
  const ids = await siteCabinets(await harborSite(), 5);
  const jobId = randomUUID();
  const planDigest = (await preview(db.app, { role: "tier1" }, "time.sync", ids)).planDigest;
  const token = await issueStepUpToken(db.app, t1.id, "fleet.job", jobId, paramsHash({ planDigest, operation: "time.sync", cabinetIds: ids, batchSize: 1 }));
  await startJob(db.app, { userId: t1.id, role: "tier1" }, { jobId, planDigest, operation: "time.sync", cabinetIds: ids, batchSize: 1, stepUpToken: token });
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
  const ids = await siteCabinets(await harborSite(), 2);
  const jobId = randomUUID();
  const T = "A".repeat(43);
  // Cabinets from two sites: refused with the password confirmation valid, and nothing is sent.
  const crossIds = [ids[0]!, (await scenarioIds("disk_failing"))[0]!];
  const crossJob = randomUUID();
  const crossToken = await confirm(t1, crossJob, { operation: "time.sync", cabinetIds: crossIds, batchSize: 1 });
  const cross = await call("POST", "/api/fleet-operations/jobs", { jobId: crossJob, operation: "time.sync", cabinetIds: crossIds, batchSize: 1, stepUpToken: crossToken }, t1);
  assert.equal(cross.status, 409, JSON.stringify(cross.body));
  assert.equal(cross.body.error, "one_site_only");
  assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM fleet_jobs WHERE id = $1", [crossJob])).rows[0]!.n, 0);
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
    const ids = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE site_id = $1 ORDER BY name", [await bigSite(size)])).rows.map(r => r.id);
    const started = Date.now();
    const j = await runToEnd(t1, "time.sync", ids, 20, 120_000);
    const reachable = (await db.app.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cabinets WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) AND last_heartbeat_at > DATEADD(minute, -5, SYSUTCDATETIME()) AND demo_scenario NOT IN ('offline', 'incident_loop')", [ids])).rows[0]!.n;
    assert.equal(j.counts.verified ?? 0, reachable, JSON.stringify(j.counts));
    assert.equal((j.counts.verified ?? 0) + (j.counts.skipped ?? 0) + (j.counts.failed ?? 0), ids.length, JSON.stringify(j.counts));
    console.log(`# scale ${size}: ${ids.length} cabinets, ${JSON.stringify(j.counts)}, ${Date.now() - started} ms`);
  });

test("two instances have one fleet job lifecycle owner", async () => {
  // A separately loaded module has its own process-local Set, as a second server would.
  const second = await import(`../src/services/fleet-jobs.js?instance=${randomUUID()}`) as typeof import("../src/services/fleet-jobs.js");
  const t1 = await account("tier1");
  const [quiet] = await scenarioIds("incident_loop");
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [quiet]);
  const cabinetIds = [quiet!], jobId = randomUUID();
  const planDigest = (await preview(db.app, { role: "tier1" }, "time.sync", cabinetIds)).planDigest;
  const token = await confirm(t1, jobId, { operation: "time.sync", cabinetIds, batchSize: 1 });
  await startJob(db.app, { userId: t1.id, role: "tier1" }, { jobId, operation: "time.sync", cabinetIds, batchSize: 1, planDigest, stepUpToken: token });

  let entered!: () => void, release!: () => void;
  const atFollowUp = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  let paused = false, expired = false, staleWrites = 0, secondReads = 0;
  // Pause A after a committed follow-up read, with no database lock held. Instrument both the
  // pool and its transactions so this observes the original runner and the fenced runner alike.
  const instancePool = (who: "a" | "b") => {
    const observe = (text: string) => {
      if (who === "a" && expired && /UPDATE fleet_job_targets|UPDATE fleet_jobs/.test(text)) staleWrites++;
      const followUp = text.includes("FROM commands WHERE id IN");
      if (who === "b" && followUp) secondReads++;
      return followUp && who === "a" && !paused;
    };
    const pause = async () => { paused = true; entered(); await gate; };
    const query: Pool["query"] = async (text, params, options) => {
      const block = observe(text);
      const result = await db.app.query(text, params, options);
      if (block) await pause();
      return result;
    };
    const transaction: Pool["transaction"] = async fn => {
      let block = false;
      const result = await db.app.transaction(c => fn(new Proxy(c, { get(target, key) {
        if (key === "query") return (text: string, params?: readonly unknown[]) => {
          block = observe(text) || block;
          return target.query(text, params);
        };
        return Reflect.get(target, key);
      } }) as Tx));
      if (block) await pause();
      return result;
    };
    return new Proxy(db.app, { get(target, key) {
      if (key === "query") return query;
      if (key === "transaction") return transaction;
      return Reflect.get(target, key);
    } });
  };
  const logs: string[] = [];
  const first = runJob(instancePool("a"), jobId, TIMING, m => logs.push(m));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([atFollowUp, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("owner never reached follow-up")), 10_000); })]);
    clearTimeout(timeout);
    // Make a competing unfenced runner terminate promptly, rather than waiting for command expiry.
    await db.app.query("UPDATE commands SET status = 'expired' WHERE bulk_id = $1 AND status = 'queued'", [jobId]);
    await second.runJob(instancePool("b"), jobId, TIMING);
    assert.equal(secondReads, 0, "B cannot follow up A's issued target while A owns the lifecycle");
    await db.app.query("UPDATE job_leases SET until = DATEADD(second, -1, SYSUTCDATETIME()) WHERE name = $1", [`fleet.job.${jobId}`]);
    expired = true;
    await second.runJob(instancePool("b"), jobId, TIMING);
    assert.ok(secondReads > 0, "B takes ownership after A's lease expires");
    release();
    await first;
    assert.equal(staleWrites, 0, "the expired owner cannot mutate targets or finish the job");
    assert.ok(logs.some(m => /ownership expired or was lost/.test(m)), JSON.stringify(logs));
    assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'fleet.job.finish' AND target_id = $1", [jobId])).rows[0]!.n, 1);
  } finally {
    clearTimeout(timeout);
    release();
    await first;
    await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -20, SYSUTCDATETIME()) WHERE id = $1", [quiet]);
  }
});

test("startup retries fleet recovery after another holder lease expires", async () => {
  const t1 = await account("tier1");
  const cabinetIds = await siteCabinets(await harborSite(), 1), jobId = randomUUID();
  const planDigest = (await preview(db.app, { role: "tier1" }, "time.sync", cabinetIds)).planDigest;
  const token = await confirm(t1, jobId, { operation: "time.sync", cabinetIds, batchSize: 1 });
  await startJob(db.app, { userId: t1.id, role: "tier1" }, { jobId, operation: "time.sync", cabinetIds, batchSize: 1, planDigest, stepUpToken: token });
  assert.equal(await takeLease(db.app, "jobs.resume-fleet-jobs", 600_000, "previous-startup"), true);
  // The startup lease expires first; the prior per-job owner can still be alive.
  assert.equal(await takeLease(db.app, `fleet.job.${jobId}`, 60_000, "previous-runner"), true);
  // Namespace lookup keeps this test runnable against the pre-fix module for the red/green proof.
  const schedule = (fleetJobs as unknown as { scheduleFleetRecovery?: (pool: Pool, timing: typeof TIMING, log: (m: string) => void, intervalMs: number) => () => void }).scheduleFleetRecovery;
  assert.equal(typeof schedule, "function", "startup must install periodic fleet recovery acquisition");
  const stop = schedule!(db.app, TIMING, () => {}, 40);
  try {
    await new Promise(r => setTimeout(r, 150));
    assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE bulk_id = $1", [jobId])).rows[0]!.n, 0);
    await db.app.query("UPDATE job_leases SET until = DATEADD(second, -1, SYSUTCDATETIME()) WHERE name = 'jobs.resume-fleet-jobs'");
    await new Promise(r => setTimeout(r, 150));
    assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE bulk_id = $1", [jobId])).rows[0]!.n, 0, "startup recovery also respects the live per-job owner");
    await db.app.query("UPDATE job_leases SET until = DATEADD(second, -1, SYSUTCDATETIME()) WHERE name = $1", [`fleet.job.${jobId}`]);
    const result = await waitDone(t1, jobId);
    assert.deepEqual(result.counts, { verified: 1 });
  } finally { stop(); }
});

for (const cancel of [false, true]) test(`periodic recovery resumes a runner lost after startup${cancel ? " and reconciles cancellation" : ""}`, async () => {
  const t1 = await account("tier1");
  const cabinetIds = await siteCabinets(await harborSite(), 1), jobId = randomUUID();
  let failed = false;
  const faulty = new Proxy(db.app, { get(target, key) {
    if (key === "transaction") return (fn: Parameters<Pool["transaction"]>[0]) => target.transaction(c => fn(new Proxy(c, { get(tx, prop) {
      if (prop === "query") return (text: string, params?: readonly unknown[]) => {
        if (!failed && text.includes("FROM commands WHERE id IN")) {
          failed = true;
          throw new Error("injected transient database failure");
        }
        return tx.query(text, params);
      };
      return Reflect.get(tx, prop);
    } }) as Tx));
    return Reflect.get(target, key);
  } });
  // Consume the startup scan before this job exists.
  const stop = fleetJobs.scheduleFleetRecovery(db.app, TIMING, () => {}, 100);
  try {
    await new Promise(r => setTimeout(r, 200));
    const planDigest = (await preview(db.app, { role: "tier1" }, "time.sync", cabinetIds)).planDigest;
    const token = await confirm(t1, jobId, { operation: "time.sync", cabinetIds, batchSize: 1 });
    await startJob(db.app, { userId: t1.id, role: "tier1" }, { jobId, operation: "time.sync", cabinetIds, batchSize: 1, planDigest, stepUpToken: token });
    const logs: string[] = [];
    await runJob(faulty, jobId, TIMING, m => logs.push(m));
    assert.ok(failed);
    assert.ok(logs.some(m => m.includes("injected transient database failure")));
    if (cancel) await fleetJobs.cancelJob(db.app, { userId: t1.id, role: "tier1" }, jobId);
    // Simulate the dead holder's lease having elapsed, without changing the production lease duration.
    await db.app.query("UPDATE job_leases SET until = DATEADD(second, -1, SYSUTCDATETIME()) WHERE name = $1", [`fleet.job.${jobId}`]);
    const end = Date.now() + 10_000;
    let finished = false;
    while (Date.now() < end) {
      finished = !!(await db.app.query<{ finished_at: Date | null }>("SELECT finished_at FROM fleet_jobs WHERE id = $1", [jobId])).rows[0]?.finished_at;
      if (finished) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(finished, "periodic recovery must finish a runner lost after its startup scan");
    const result = await fleetJobs.job(db.app, jobId);
    assert.equal(result!.state, cancel ? "cancelled" : "done");
    assert.deepEqual(result!.counts, { verified: 1 });
    assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE bulk_id = $1", [jobId])).rows[0]!.n, 1, "recovery never reissues the outstanding change");
  } finally { stop(); }
});

test("each issued target keeps its own budget and known offline targets settle promptly", async () => {
  const owner = await account("tier1");
  const site = await bigSite(3);
  const ids = await siteCabinets(site, 3);
  const jobId = randomUUID();
  const commands = ids.map(() => randomUUID());
  await db.app.query("UPDATE cabinets SET demo_scenario = NULL WHERE site_id = $1", [site]);
  await db.app.query("INSERT INTO fleet_jobs (id, operation, created_by, batch_size, total) VALUES ($1, 'time.sync', $2, 3, 3)", [jobId, owner.id]);
  for (let i = 0; i < ids.length; i++) {
    await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
      VALUES ($1, $2, 'time.sync', '{}', $3, DATEADD(second, $5, SYSUTCDATETIME()), DATEADD(minute, 2, SYSUTCDATETIME()), 'queued', $4)`,
    [commands[i], ids[i], owner.id, jobId, i === 0 ? -10 : 0]);
    await db.app.query(`INSERT INTO fleet_job_targets (job_id, cabinet_id, [position], params, state, command_id)
      VALUES ($1, $2, $3, '{}', 'issued', $4)`, [jobId, ids[i], i, commands[i]]);
  }
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -1, SYSUTCDATETIME()) WHERE id = $1", [ids[2]]);
  const logs: string[] = [];
  const runner = runJob(db.app, jobId, { pollMs: 30, verifyMs: 200, batchMs: 2000 }, m => logs.push(m));
  try {
    await new Promise(r => setTimeout(r, 500));
    const targets = (await db.app.query<{ cabinet_id: string; state: string }>("SELECT cabinet_id, state FROM fleet_job_targets WHERE job_id = $1", [jobId])).rows;
    const state = (id: string) => targets.find(t => t.cabinet_id === id)!.state;
    assert.equal(state(ids[0]!), "failed", "the older command exhausts its own budget promptly");
    assert.equal(state(ids[1]!), "issued", "the fresh neighbour still has its own budget");
    assert.equal(state(ids[2]!), "offline", "known offline cabinets do not wait for expiry");
    await new Promise(r => setTimeout(r, 2000));
    assert.equal((await fleetJobs.job(db.app, jobId))!.state, "done", "the fresh target also exhausts its budget without leaving the job running");
  } finally {
    // Also bounds cleanup when exercising the old shared deadline in the red proof.
    await db.app.query("UPDATE commands SET status = 'expired' WHERE bulk_id = $1", [jobId]);
    await runner;
  }
  assert.deepEqual(logs, []);
  assert.equal((await fleetJobs.job(db.app, jobId))!.state, "done");
});


test("offline targets have no deliverable command after their independent budgets settle", async () => {
  const owner = await account("tier1");
  const site = await bigSite(2);
  const ids = await siteCabinets(site, 2);
  const jobId = randomUUID();
  const commands = ids.map(() => randomUUID());
  await db.app.query("UPDATE cabinets SET demo_scenario = NULL WHERE site_id = $1", [site]);
  await db.app.query("INSERT INTO fleet_jobs (id, operation, created_by, batch_size, total) VALUES ($1, 'time.sync', $2, 2, 2)", [jobId, owner.id]);
  for (let i = 0; i < ids.length; i++) {
    await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
      VALUES ($1, $2, 'time.sync', '{}', $3, DATEADD(second, $5, SYSUTCDATETIME()), DATEADD(minute, 2, SYSUTCDATETIME()), 'queued', $4)`,
    [commands[i], ids[i], owner.id, jobId, i === 0 ? -10 : 0]);
    await db.app.query(`INSERT INTO fleet_job_targets (job_id, cabinet_id, [position], params, state, command_id)
      VALUES ($1, $2, $3, '{}', 'issued', $4)`, [jobId, ids[i], i, commands[i]]);
  }
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -1, SYSUTCDATETIME()) WHERE id = $1", [ids[1]]);
  const logs: string[] = [];
  const runner = runJob(db.app, jobId, { pollMs: 30, verifyMs: 100, batchMs: 1500 }, m => logs.push(m));
  try {
    await Promise.race([runner, new Promise(r => setTimeout(r, 2500))]);
    assert.equal((await fleetJobs.job(db.app, jobId))!.state, "done");
    assert.equal((await fleetJobs.job(db.app, jobId))!.cabinets.find(c => c.id === ids[1])!.state, "offline");
    await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [ids[1]]);
    assert.deepEqual((await takeLeasedCommands(db.app, ids[1]!)).commands, [], "returning agent cannot take the offline target's command");
    assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE bulk_id = $1 AND status IN ('queued', 'delivered')", [jobId])).rows[0]!.n, 0);
    assert.deepEqual(logs, []);
  } finally {
    await db.app.query("UPDATE commands SET status = 'expired' WHERE bulk_id = $1", [jobId]);
    await runner;
  }
});

test("a waiting command removed mid-flight cannot keep the runner polling", async () => {
  const owner = await account("tier1");
  const site = await bigSite(1);
  const id = (await siteCabinets(site, 1))[0]!;
  const jobId = randomUUID(), commandId = randomUUID();
  await db.app.query("UPDATE cabinets SET demo_scenario = NULL WHERE id = $1", [id]);
  await db.app.query("INSERT INTO fleet_jobs (id, operation, created_by, batch_size, total) VALUES ($1, 'time.sync', $2, 1, 1)", [jobId, owner.id]);
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
    VALUES ($1, $2, 'time.sync', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 2, SYSUTCDATETIME()), 'queued', $4)`, [commandId, id, owner.id, jobId]);
  await db.app.query(`INSERT INTO fleet_job_targets (job_id, cabinet_id, [position], params, state, command_id)
    VALUES ($1, $2, 0, '{}', 'issued', $3)`, [jobId, id, commandId]);
  let polls = 0;
  const observed = new Proxy(db.app, { get(target, key) {
    if (key === "transaction") return ((fn) => target.transaction(c => fn(new Proxy(c, { get(tx, prop) {
      if (prop === "query") return (text: string, values?: readonly unknown[]) => {
        if (/SELECT id, status, issued_at/.test(text)) polls++;
        return tx.query(text, values);
      };
      return Reflect.get(tx, prop);
    } }) as Tx))) as Pool["transaction"];
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const logs: string[] = [];
  const runner = runJob(observed, jobId, { pollMs: 30, verifyMs: 100, batchMs: 1500 }, m => logs.push(m));
  try {
    for (let i = 0; polls === 0 && i < 100; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(polls > 0, "the runner polled the waiting command before removal");
    // Retention clears references before deleting the command.
    await db.app.query("UPDATE fleet_job_targets SET command_id = NULL WHERE job_id = $1", [jobId]);
    await db.app.query("DELETE FROM commands WHERE id = $1", [commandId]);
    await Promise.race([runner, new Promise(r => setTimeout(r, 2500))]);
    assert.equal((await fleetJobs.job(db.app, jobId))!.state, "done");
    assert.equal((await fleetJobs.job(db.app, jobId))!.cabinets[0]!.state, "failed");
    const finishedPolls = polls;
    await new Promise(r => setTimeout(r, 100));
    assert.equal(polls, finishedPolls, "polling stops after the missing command settles");
    assert.deepEqual(logs, []);
  } finally {
    // A bounded shared-deadline mutant can also finish cleanly after this row is restored.
    await db.app.query(`IF NOT EXISTS (SELECT 1 FROM commands WHERE id = $1)
      INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
      VALUES ($1, $2, 'time.sync', '{}', $3, DATEADD(minute, -2, SYSUTCDATETIME()), DATEADD(minute, -1, SYSUTCDATETIME()), 'expired', $4)`, [commandId, id, owner.id, jobId]);
    await runner;
  }
});


test("a command issued at the withdrawal instant settles without violating its expiry constraint", async () => {
  const owner = await account("tier1");
  const site = await bigSite(1);
  const id = (await siteCabinets(site, 1))[0]!;
  const jobId = randomUUID(), commandId = randomUUID();
  await db.app.query("UPDATE cabinets SET demo_scenario = NULL, last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [id]);
  await db.app.query("INSERT INTO fleet_jobs (id, operation, created_by, batch_size, total) VALUES ($1, 'time.sync', $2, 1, 1)", [jobId, owner.id]);
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
    VALUES ($1, $2, 'time.sync', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 2, SYSUTCDATETIME()), 'queued', $4)`, [commandId, id, owner.id, jobId]);
  await db.app.query(`INSERT INTO fleet_job_targets (job_id, cabinet_id, [position], params, state, command_id)
    VALUES ($1, $2, 0, '{}', 'issued', $3)`, [jobId, id, commandId]);
  let withdrawals = 0;
  const simultaneous = new Proxy(db.app, { get(target, key) {
    if (key === "transaction") return ((fn) => target.transaction(c => fn(new Proxy(c, { get(tx, prop) {
      if (prop === "query") return (text: string, values?: readonly unknown[]) => {
        if (text.includes("UPDATE commands SET status = CASE")) {
          withdrawals++;
          // Run the real withdrawal SQL with issue time and retirement time exactly equal.
          return tx.query(`DECLARE @retiredAt datetime2(3) = SYSUTCDATETIME();
            UPDATE commands SET issued_at = @retiredAt, expires_at = DATEADD(minute, 2, @retiredAt) WHERE id = $4;
            ${text.replaceAll("SYSUTCDATETIME()", "@retiredAt")}`, [...values!, commandId]);
        }
        return tx.query(text, values);
      };
      return Reflect.get(tx, prop);
    } }) as Tx))) as Pool["transaction"];
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const logs: string[] = [];
  await runJob(simultaneous, jobId, { pollMs: 0, verifyMs: 100, batchMs: 0 }, m => logs.push(m));
  assert.equal(withdrawals, 1);
  assert.deepEqual(logs, []);
  const result = (await fleetJobs.job(db.app, jobId))!;
  assert.equal(result.state, "done");
  assert.equal(result.cabinets[0]!.state, "failed");
  const command = (await db.app.query<{ status: string; lifetime_ms: number }>(
    "SELECT status, DATEDIFF(millisecond, issued_at, expires_at) AS lifetime_ms FROM commands WHERE id = $1", [commandId])).rows[0]!;
  assert.equal(command.status, "failed");
  assert.equal(command.lifetime_ms, 1);
});

for (const outcome of ["expired", "failed", "audit-failure"] as const) test(`fleet withdrawal audits its retirement atomically: ${outcome}`, async () => {
  const owner = await account("tier1");
  const site = await bigSite(1);
  const id = (await siteCabinets(site, 1))[0]!;
  const jobId = randomUUID(), commandId = randomUUID();
  await db.app.query(`UPDATE cabinets SET demo_scenario = NULL, last_heartbeat_at = ${outcome === "expired" ? "DATEADD(hour, -1, SYSUTCDATETIME())" : "SYSUTCDATETIME()"} WHERE id = $1`, [id]);
  await db.app.query("INSERT INTO fleet_jobs (id, operation, created_by, batch_size, total) VALUES ($1, 'time.sync', $2, 1, 1)", [jobId, owner.id]);
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
    VALUES ($1, $2, 'time.sync', '{}', $3, DATEADD(second, -10, SYSUTCDATETIME()), DATEADD(minute, 2, SYSUTCDATETIME()), 'queued', $4)`, [commandId, id, owner.id, jobId]);
  await db.app.query(`INSERT INTO fleet_job_targets (job_id, cabinet_id, [position], params, state, command_id)
    VALUES ($1, $2, 0, '{}', 'issued', $3)`, [jobId, id, commandId]);
  const before = (await db.app.query<{ expires_at: Date }>("SELECT expires_at FROM commands WHERE id = $1", [commandId])).rows[0]!;
  let rejectedAudit = false;
  const faulty = new Proxy(db.app, { get(target, key) {
    if (key === "transaction") return ((fn) => target.transaction(c => fn(new Proxy(c, { get(tx, prop) {
      if (prop === "query") return (text: string, values?: readonly unknown[]) => {
        if (outcome === "audit-failure" && text.includes("EXEC audit_append_many")) {
          rejectedAudit = true;
          throw new Error("injected withdrawal audit failure");
        }
        return tx.query(text, values);
      };
      return Reflect.get(tx, prop);
    } }) as Tx))) as Pool["transaction"];
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const logs: string[] = [];
  await runJob(faulty, jobId, { pollMs: 0, verifyMs: 100, batchMs: 0 }, m => logs.push(m));
  const command = (await db.app.query<{ status: string; expires_at: Date }>("SELECT status, expires_at FROM commands WHERE id = $1", [commandId])).rows[0]!;
  const entries = (await db.app.query<{ actor_kind: string; actor_id: string; action: string; target_kind: string; target_id: string; outcome: string; details: Record<string, unknown> }>(
    "SELECT actor_kind, actor_id, action, target_kind, target_id, outcome, details FROM audit_log WHERE target_id = $1 AND action = 'command.expire'", [commandId])).rows;
  if (outcome === "audit-failure") {
    assert.equal(rejectedAudit, true, "retirement attempts to append its audit row");
    assert.ok(logs.some(m => m.includes("injected withdrawal audit failure")));
    assert.equal(command.status, "queued", "an unaudited retirement rolls back");
    assert.deepEqual(command.expires_at, before.expires_at, "withdrawal rolls back with the status");
    assert.equal(entries.length, 0);
    assert.equal((await fleetJobs.job(db.app, jobId))!.cabinets[0]!.state, "issued");
  } else {
    assert.deepEqual(logs, []);
    assert.equal(command.status, outcome);
    assert.deepEqual(entries, [{ actor_kind: "system", actor_id: "command-expiry", action: "command.expire", target_kind: "command", target_id: commandId,
      outcome: "succeeded", details: { cabinetId: id, operation: "time.sync", jobId, status: outcome, why: "fleet-job-withdrawal", delivered: false, automatic: true } }]);
    assert.equal((await fleetJobs.job(db.app, jobId))!.state, "done");
  }
});

for (const n of [205, 7, 0]) test(`cabinet selection reports the same filtered match count as its capped list (${n} matches)`, async () => {
  const siteId = await bigSite(n);
  const t1 = await account("tier1");
  // Names stay distinct: `cabinets_site_id_name_key` allows one cabinet name per site, so no fixture can make two
  // cabinets in a site share a display name and the id tie-break in the ordering cannot be reached from here. What the
  // ordering has to guarantee is observed the way it can be: two identical calls return the same order.
  const clientId = (await db.app.query<{ client_id: string }>("SELECT client_id FROM sites WHERE id = $1", [siteId])).rows[0]!.client_id;
  const filter = { siteId, clientId, problem: "any" as const };
  const first = await fleetJobs.fleetCabinets(db.app, filter);
  assert.deepEqual(first.limits.cabinets, { shown: Math.min(n, 200), matched: n, limit: 200 });
  assert.equal(first.cabinets.length, Math.min(n, 200));
  const expected = (await db.app.query<{ id: string }>("SELECT TOP (200) id FROM cabinets WHERE site_id = $1 ORDER BY name, id", [siteId])).rows.map(r => r.id);
  assert.deepEqual(first.cabinets.map(r => r.id), expected);
  const second = await fleetJobs.fleetCabinets(db.app, filter);
  assert.deepEqual(second.cabinets.map(r => r.id), first.cabinets.map(r => r.id));
  const route = await call("GET", `/api/fleet-operations/cabinets?siteId=${siteId}&clientId=${clientId}&problem=any`, undefined, t1);
  assert.equal(route.status, 200);
  assert.deepEqual(route.body.limits, first.limits);
  assert.deepEqual(route.body.cabinets, first.cabinets);
  if (n > 0) {
    const row = first.cabinets[0]!;
    assert.deepEqual(Object.keys(row).sort(), ["id", "name", "role", "site", "client", "demo", "readOnly", "online", "timeZoneId", "clockSkewSeconds", "ipv4", "openAlerts"].sort());
    assert.deepEqual(row, { id: expected[0], name: (await db.app.query<{ name: string }>("SELECT name FROM cabinets WHERE id = $1", [expected[0]])).rows[0]!.name, role: "satellite", site: { id: siteId, name: (await db.app.query<{ name: string }>("SELECT name FROM sites WHERE id = $1", [siteId])).rows[0]!.name, timeZone: "Eastern Standard Time" },
      client: { id: clientId, name: (await db.app.query<{ name: string }>("SELECT name FROM clients WHERE id = $1", [clientId])).rows[0]!.name },
      demo: true, readOnly: false, online: true, timeZoneId: "Eastern Standard Time", clockSkewSeconds: 0.3, ipv4: null, openAlerts: 0 });
  }
  const noProblem = await fleetJobs.fleetCabinets(db.app, { ...filter, problem: "time_zone_wrong" });
  assert.deepEqual(noProblem, { cabinets: [], limits: { cabinets: { shown: 0, matched: 0, limit: 200 } } });
});

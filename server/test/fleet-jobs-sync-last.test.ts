// Sync cabinets in a bulk job (docs/spec/05-server-spec.md "Fleet operations", the owner's decision for 8e): they go last, in batches of
// their own, and only once every satellite in the job checked out; a satellite that failed or went unverified keeps every sync
// cabinet in the job unchanged, with the reason. A small fake agent answers through the commands table.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/passwords.js";
import { paramsHash } from "../src/auth/canonical.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { NULL_BINARY } from "../src/db/db.js";
import { doubtReason, job, preview, runJob, startJob } from "../src/services/fleet-jobs.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let adminId: string;
const TIMING = { pollMs: 40, verifyMs: 5_000 };
const ALL_ON = { domain: true, private: true, public: true };

test.before(async () => {
  db = await createTestDatabase();
  adminId = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed, write_limit)
                      VALUES ($1, $2, 'Jobs Admin', 'admin', $3, 0, 0, $4, 1, 50)`, [adminId, "jobs." + randomBytes(3).toString("hex"), await hashPassword(randomBytes(12).toString("hex")), NULL_BINARY]);
});
test.after(async () => { await db.drop(); });

/** A site whose firewall policy is all off, with cabinets reporting all on (so each would be changed). */
async function site(name: string, cabinets: [string, "sync" | "satellite" | "standalone"][]) {
  const [client, siteId] = [randomUUID(), randomUUID()];
  await db.app.query("INSERT INTO clients (id, name, firewall_policy) VALUES ($1, $2, $3)", [client, name, JSON.stringify({ domain: "off", private: "off", public: "off" })]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [siteId, client]);
  const ids: Record<string, string> = {};
  for (const [n, role] of cabinets) {
    ids[n] = randomUUID();
    await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, read_only, last_heartbeat_at, firewall_profiles) VALUES ($1, $2, $3, $4, 'active', 0, SYSUTCDATETIME(), $5)`,
      [ids[n], siteId, n, role, JSON.stringify(ALL_ON)]);
  }
  return ids;
}

/** Answers firewall.applyPolicy for these cabinets, in the order the commands arrive; `fail` names the cabinets whose change fails. */
function fakeAgent(ids: Record<string, string>, fail: string[] = []) {
  const byId = new Map(Object.entries(ids).map(([n, id]) => [id.toLowerCase(), n]));
  const seen: string[] = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const queued = (await db.app.query<{ id: string; cabinet_id: string; params: { profiles: object } }>(
        "SELECT id, cabinet_id, params FROM commands WHERE cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) AND status = 'queued' ORDER BY issued_at",
        [Object.values(ids)])).rows;
      for (const c of queued) {
        const name = byId.get(c.cabinet_id.toLowerCase())!;
        seen.push(name);
        if (fail.includes(name)) {
          await db.app.query("UPDATE commands SET status = 'failed', result = $2, result_at = SYSUTCDATETIME() WHERE id = $1",
            [c.id, JSON.stringify({ error: { code: "operation_failed", message: "the firewall service did not answer" } })]);
          continue;
        }
        await db.app.query("UPDATE commands SET status = 'succeeded', result = $2, result_at = SYSUTCDATETIME() WHERE id = $1", [c.id, JSON.stringify({ output: {} })]);
        await new Promise(r => setTimeout(r, 20));
        await db.app.query("UPDATE cabinets SET firewall_profiles = $2, last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [c.cabinet_id, JSON.stringify(c.params.profiles)]);
      }
      await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [Object.values(ids)]);
      await new Promise(r => setTimeout(r, 30));
    }
  })();
  return { seen, stop: async () => { stop = true; await loop; } };
}

async function run(ids: Record<string, string>, order: string[], batchSize: number, fail: string[] = [], beforeRun?: (jobId: string) => Promise<void>, chosen?: string[]) {
  // The fake agent answers for `ids`; the job covers `chosen` when given (a cabinet that never answers, such as an offline one, is in the job only).
  const cabinetIds = chosen ?? order.map(n => ids[n]!);
  const jobId = randomUUID();
  const planDigest = (await preview(db.app, { role: "admin" }, "firewall.applyPolicy", cabinetIds)).planDigest;
  const token = await issueStepUpToken(db.app, adminId, "fleet.job", jobId, paramsHash({ operation: "firewall.applyPolicy", cabinetIds, batchSize, planDigest }));
  await startJob(db.app, { userId: adminId, role: "admin" }, { jobId, operation: "firewall.applyPolicy", cabinetIds, batchSize, planDigest, stepUpToken: token });
  if (beforeRun) await beforeRun(jobId);
  const agent = fakeAgent(ids, fail);
  try { await runJob(db.app, jobId, TIMING); } finally { await agent.stop(); }
  return { seen: agent.seen, result: (await job(db.app, jobId))! };
}
const stateOf = (r: Awaited<ReturnType<typeof job>>, name: string) => r!.cabinets.find(c => c.name === name)!;

test("the preview and the job put sync cabinets last, whatever order they were chosen in", async () => {
  const ids = await site("Order Health", [["SYNC", "sync"], ["SAT A", "satellite"], ["SOLO", "standalone"], ["SAT B", "satellite"]]);
  const p = await preview(db.app, { role: "admin" }, "firewall.applyPolicy", ["SYNC", "SAT A", "SOLO", "SAT B"].map(n => ids[n]!));
  assert.deepEqual(p.cabinets.map(c => c.name), ["SAT A", "SOLO", "SAT B", "SYNC"]);
  assert.equal(p.cabinets.at(-1)!.role, "sync");
  // Even with a batch large enough for all of them, the sync cabinet is sent on its own, after the others are verified.
  const { seen, result } = await run(ids, ["SYNC", "SAT A", "SOLO", "SAT B"], 10);
  assert.deepEqual(seen.at(-1), "SYNC");
  assert.equal(seen.length, 4);
  assert.deepEqual(result.cabinets.map(c => c.state), ["verified", "verified", "verified", "verified"]);
});

test("a satellite that fails keeps the sync cabinets unchanged, and says which satellite", async () => {
  const ids = await site("Doubt Health", [["SYNC 1", "sync"], ["SYNC 2", "sync"], ["SAT A", "satellite"], ["SAT B", "satellite"]]);
  const { seen, result } = await run(ids, ["SYNC 1", "SAT A", "SYNC 2", "SAT B"], 1, ["SAT B"]);
  assert.deepEqual(seen.sort(), ["SAT A", "SAT B"], "no command reached a sync cabinet");
  assert.equal(stateOf(result, "SAT B").state, "failed");
  for (const n of ["SYNC 1", "SYNC 2"]) {
    assert.equal(stateOf(result, n).state, "skipped");
    assert.match(stateOf(result, n).detail!, /a satellite in this job did not check out \(SAT B\)/);
  }
  const syncFirewall = (await db.app.query<{ f: unknown }>("SELECT firewall_profiles AS f FROM cabinets WHERE id = $1", [ids["SYNC 1"]])).rows[0]!.f;
  assert.deepEqual(typeof syncFirewall === "string" ? JSON.parse(syncFirewall) : syncFirewall, ALL_ON);
});

test("a standalone cabinet that fails does not hold the sync cabinet back, and a job of sync cabinets alone runs", async () => {
  const ids = await site("Solo Health", [["SYNC", "sync"], ["SOLO", "standalone"], ["SAT", "satellite"]]);
  const { result } = await run(ids, ["SYNC", "SOLO", "SAT"], 2, ["SOLO"]);
  assert.deepEqual([stateOf(result, "SOLO").state, stateOf(result, "SAT").state, stateOf(result, "SYNC").state], ["failed", "verified", "verified"]);

  const only = await site("Only Sync Health", [["SYNC A", "sync"], ["SYNC B", "sync"]]);
  const r2 = await run(only, ["SYNC A", "SYNC B"], 1);
  assert.deepEqual(r2.result.cabinets.map(c => c.state), ["verified", "verified"]);
});

test("a satellite left waiting for verification by a server restart holds the sync cabinets back too", async () => {
  const ids = await site("Restart Health", [["SAT A", "satellite"], ["SYNC", "sync"]]);
  // The state a restart inside the verification window leaves: the cabinet answered, nothing verified it, and resuming does not revisit it.
  const { seen, result } = await run(ids, ["SAT A", "SYNC"], 1, [], jobId => db.app.query(
    "UPDATE fleet_job_targets SET state = 'succeeded', detail = 'The cabinet made the change; waiting for its next report to verify it.' WHERE job_id = $1 AND cabinet_id = $2",
    [jobId, ids["SAT A"]]).then(() => undefined));
  assert.deepEqual(seen, [], "no command reached the sync cabinet");
  assert.equal(stateOf(result, "SYNC").state, "skipped");
  assert.match(stateOf(result, "SYNC").detail!, /did not check out \(SAT A\)/);
});

test("the reason names whole satellites and stays within its 300 characters", () => {
  assert.equal(doubtReason(["SAT A", "SAT B"]), "Not changed: a satellite in this job did not check out (SAT A, SAT B), and a sync cabinet serves every satellite at its site.");
  const long = ["A".repeat(100), "B".repeat(100), "C".repeat(100)];
  const text = doubtReason(long);
  assert.ok(text.length <= 300, String(text.length));
  assert.match(text, new RegExp(`\\(${"A".repeat(100)} and 2 more\\)`));
  assert.match(doubtReason(["X".repeat(200)]), /\(1 more\)/);
});

test("a satellite skipped before its turn (offline) does not hold the sync cabinet back", async () => {
  const ids = await site("Skipped Health", [["SAT A", "satellite"], ["SAT OFF", "satellite"], ["SYNC", "sync"]]);
  // Offline: the plan skips it, so it is never changed and says nothing about the change.
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -2, SYSUTCDATETIME()) WHERE id = $1", [ids["SAT OFF"]]);
  const agent = { ...ids };
  delete agent["SAT OFF"];
  const { seen, result } = await run(agent, [], 1, [], undefined, ["SAT A", "SAT OFF", "SYNC"].map(n => ids[n]!));
  assert.deepEqual(seen, ["SAT A", "SYNC"]);
  assert.equal(stateOf(result, "SAT OFF").state, "skipped");
  assert.equal(stateOf(result, "SYNC").state, "verified");
});

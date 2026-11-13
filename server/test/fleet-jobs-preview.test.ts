import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { paramsHash } from "../src/auth/canonical.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { preview, runJob, startJob, type JobOperation } from "../src/services/fleet-jobs.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let userId: string;
const user = () => ({ userId, role: "admin" as const });
test.before(async () => {
  db = await createTestDatabase();
  userId = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, $2, 'Preview Admin', 'admin', 'x')", [userId, "preview.owner"]);
});
test.after(async () => { await db?.drop(); });

async function fixture() {
  const clientId = randomUUID(), siteId = randomUUID(), cabinetId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [clientId, clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name, time_zone) VALUES ($1, $2, 'Preview', 'Eastern Standard Time')", [siteId, clientId]);
  await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, read_only, last_heartbeat_at, time_zone_id)
    VALUES ($1, $2, 'Preview', 'standalone', 'active', 0, SYSUTCDATETIME(), 'UTC')`, [cabinetId, siteId]);
  return { siteId, cabinetId };
}
async function confirmed(operation: JobOperation, cabinetId: string) {
  const p = await preview(db.app, user(), operation, [cabinetId]);
  const jobId = randomUUID();
  const bound = { operation, cabinetIds: [cabinetId], batchSize: 1, ...(p.planDigest === undefined ? {} : { planDigest: p.planDigest }) };
  const stepUpToken = await issueStepUpToken(db.app, userId, "fleet.job", jobId, paramsHash(bound));
  return { jobId, ...bound, planDigest: p.planDigest, stepUpToken };
}
async function refused(r: Awaited<ReturnType<typeof confirmed>>, code = "preview_changed") {
  await assert.rejects(startJob(db.app, user(), r), { code });
  await runJob(db.app, r.jobId);
  assert.equal((await db.app.query("SELECT id FROM fleet_jobs WHERE id = $1", [r.jobId])).rows.length, 0);
  assert.equal((await db.app.query("SELECT id FROM commands WHERE bulk_id = $1", [r.jobId])).rows.length, 0);
  assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'fleet.job.start' AND target_id = $1", [r.jobId])).rows[0].n, 0);
}

for (const change of ["parameters", "change to skip", "skip to change", "missing target"] as const) {
  test(`confirmed fleet preview refuses changed zone plan: ${change}`, async () => {
    const { siteId, cabinetId } = await fixture();
    if (change === "skip to change") await db.app.query("UPDATE cabinets SET time_zone_id = 'Eastern Standard Time' WHERE id = $1", [cabinetId]);
    const r = await confirmed("time.setZone", cabinetId);
    if (change === "missing target") await db.app.query("DELETE FROM cabinets WHERE id = $1", [cabinetId]);
    // Into the site's own zone: the plan flips from a change to a skip. 'UTC' is not a zone a site may hold (sites_time_zone_check).
    else if (change === "change to skip") await db.app.query("UPDATE cabinets SET time_zone_id = 'Eastern Standard Time' WHERE id = $1", [cabinetId]);
    else await db.app.query("UPDATE sites SET time_zone = 'Pacific Standard Time' WHERE id = $1", [siteId]);
    await refused(r);
  });
}

async function diagnosis(cabinetId: string, action: object) {
  await db.app.query(`INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, finished_at, findings)
    VALUES ($1, $2, 'network', $3, 'done', SYSUTCDATETIME(), $4)`,
    [randomUUID(), cabinetId, userId, JSON.stringify([{ severity: "warning", action }])]);
}
test("confirmed fleet preview refuses a newer network diagnosis with another adapter and DNS servers", async () => {
  const { cabinetId } = await fixture();
  await diagnosis(cabinetId, { kind: "set_dns", interfaceIndex: 1, servers: ["1.1.1.1"] });
  const r = await confirmed("network.setDns", cabinetId);
  // Make the earlier report unambiguously older without timing assumptions.
  await db.app.query("UPDATE diagnoses SET started_at = DATEADD(minute, -1, SYSUTCDATETIME()) WHERE cabinet_id = $1", [cabinetId]);
  await diagnosis(cabinetId, { kind: "set_dns", interfaceIndex: 2, servers: ["8.8.8.8"] });
  await refused(r);
});
test("the step-up token carries the digest, so swapping it after signing is refused", async () => {
  const { cabinetId, siteId } = await fixture();
  const r = await confirmed("time.setZone", cabinetId);
  await db.app.query("UPDATE sites SET time_zone = 'Pacific Standard Time' WHERE id = $1", [siteId]);
  r.planDigest = (await preview(db.app, user(), "time.setZone", [cabinetId])).planDigest;
  await refused(r, "step_up_required");
});
test("unchanged server plan starts and canonical digest ignores diagnosis object key order", async () => {
  const { cabinetId } = await fixture();
  await diagnosis(cabinetId, { kind: "set_dns", interfaceIndex: 1, servers: ["1.1.1.1"] });
  const r = await confirmed("network.setDns", cabinetId);
  assert.match(r.planDigest, /^[0-9a-f]{64}$/, "the preview hands back a digest for the confirmation to bind");
  await db.app.query("UPDATE diagnoses SET findings = $2 WHERE cabinet_id = $1", [cabinetId,
    JSON.stringify([{ severity: "warning", action: { servers: ["1.1.1.1"], interfaceIndex: 1, kind: "set_dns" } }])]);
  assert.equal((await preview(db.app, user(), "network.setDns", [cabinetId])).planDigest, r.planDigest);
  const started = await startJob(db.app, user(), r);
  assert.equal(started.change, 1);
  const targets = (await db.app.query<{ params: unknown }>("SELECT params FROM fleet_job_targets WHERE job_id = $1", [r.jobId])).rows;
  assert.deepEqual(targets.map(t => t.params), [{ interfaceIndex: 1, mode: "static", servers: ["1.1.1.1"] }]);
});

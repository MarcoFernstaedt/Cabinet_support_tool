// Finished fleet jobs and their per-cabinet results are removed by fleet-jobs.ts, their owner (F21.R2, decision-log D73): only finished
// jobs older than the cut-off, their targets first; a running job is never removed; a cut-off that is not a past time is refused; a
// repeat removes nothing more.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pruneFinishedJobs } from "../src/services/fleet-jobs.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
const user = randomUUID(), cabinet = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'jobs.admin', 'Jobs', 'admin')", [user]);
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Jobs')", [client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [cabinet, site]);
});
test.after(async () => { await db?.drop(); });
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
async function job(state: "running" | "done" | "cancelled", age: number): Promise<string> {
  const id = randomUUID();
  await db.app.query("INSERT INTO fleet_jobs (id, operation, created_by, batch_size, total, state, created_at) VALUES ($1, 'time.sync', $2, 10, 1, $3, $4)", [id, user, state, daysAgo(age)]);
  await db.app.query("INSERT INTO fleet_job_targets (job_id, cabinet_id, position, state) VALUES ($1, $2, 0, $3)", [id, cabinet, state === "running" ? "pending" : "succeeded"]);
  return id;
}
const there = async (id: string) => [
  Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM fleet_jobs WHERE id = $1", [id])).rows[0]!.n),
  Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM fleet_job_targets WHERE job_id = $1", [id])).rows[0]!.n)];

test("finished jobs older than the cut-off go with their results; a running one and a recent one stay; a repeat removes nothing", async () => {
  const [oldDone, oldCancelled, oldRunning, recent] = [await job("done", 400), await job("cancelled", 380), await job("running", 400), await job("done", 10)];
  assert.equal(await pruneFinishedJobs(db.app, daysAgo(365)), 2);
  assert.deepEqual([await there(oldDone), await there(oldCancelled), await there(oldRunning), await there(recent)], [[0, 0], [0, 0], [1, 1], [1, 1]]);
  assert.equal(await pruneFinishedJobs(db.app, daysAgo(365)), 0);
  const batches = async (table: string) => (await db.app.query<{ details: { rows: number } }>(
    "SELECT details FROM audit_log WHERE action = 'retention.batch' AND JSON_VALUE(details, '$.table') = $1", [table])).rows.map(r => r.details.rows);
  assert.deepEqual([await batches("fleet_job_targets"), await batches("fleet_jobs")], [[2], [2]]);
});

test("a cut-off that is not a time already passed is refused before anything is removed", async () => {
  const old = await job("done", 900);
  for (const bad of [new Date(Date.now() + 60_000), new Date("x"), "2020-01-01", 1, null, undefined])
    await assert.rejects(pruneFinishedJobs(db.app, bad as never), /retention cut-off/, String(bad));
  assert.deepEqual(await there(old), [1, 1]);
});

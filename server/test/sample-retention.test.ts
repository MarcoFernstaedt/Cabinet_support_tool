// The last cross-module write in the retention run, moved behind its owner (F21.R2, decision-log D77): raw health samples already rolled
// up are removed by cabinets.ts, inside the run's own transaction. (Drive samples went with SMART, D151.)
// Only the cabinets named and only rows older than the time given go; the ids, the time and the options are checked before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dropRolledUpHealthSamples } from "../src/services/cabinets.js";
import { transaction } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

const FAST = { batch: 2, pauseMs: 0, timeoutMs: 30_000 };
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function cabinet(): Promise<string> {
  const client = randomUUID(), site = randomUUID(), k = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [k, site]);
  return k;
}
const healthSample = (k: string, days: number) => db.app.query(
  "INSERT INTO health_samples (cabinet_id, [at], cpu_percent, memory_used_percent, disk_free_percent) VALUES ($1, DATEADD(day, -$2, SYSUTCDATETIME()), 1, 1, 1)", [k, days]);
const count = async (table: "health_samples", k: string) =>
  (await db.app.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE cabinet_id = $1`, [k])).rows[0]!.n;

test("raw health samples before the time go for the cabinets named, inside the caller's transaction; a rollback keeps them", async () => {
  const [a, other] = [await cabinet(), await cabinet()];
  for (const k of [a, other]) { await healthSample(k, 3); await healthSample(k, 2); await healthSample(k, 0); }
  await assert.rejects(transaction(db.app, async c => {
    assert.equal(await dropRolledUpHealthSamples(c, [a], daysAgo(1), FAST), 2);
    throw new Error("stop");
  }), /stop/);
  assert.equal(await count("health_samples", a), 3, "rolled back with the transaction it ran in");
  assert.equal(await transaction(db.app, c => dropRolledUpHealthSamples(c, [a], daysAgo(1), FAST)), 2);
  assert.deepEqual([await count("health_samples", a), await count("health_samples", other)], [1, 3]);
  assert.equal(await transaction(db.app, c => dropRolledUpHealthSamples(c, [a], daysAgo(1), FAST)), 0);
});

test("anything but a list of cabinet ids, a past time and whole-number options is refused before the database is touched", async () => {
  const k = await cabinet();
  await healthSample(k, 5);
  const badIds = [undefined, null, "", k, [""], ["not-an-id"], ["' OR 1=1 --"], [`${k}"]`], [`${k}; DELETE FROM health_samples`], [k, 42], [{}], { length: 1, 0: k }];
  for (const ids of badIds) {
    await assert.rejects(dropRolledUpHealthSamples(db.app, ids as never, daysAgo(1), FAST), /cabinet ids/, JSON.stringify(ids) ?? String(ids));
  }
  for (const when of [undefined, null, "2020-01-01", Date.now(), new Date(Number.NaN), new Date(Date.now() + 3_600_000)]) {
    await assert.rejects(dropRolledUpHealthSamples(db.app, [k], when as never, FAST), /already passed/, String(when));
  }
  for (const o of [undefined, null, {}, { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: "30000" }])
    await assert.rejects(dropRolledUpHealthSamples(db.app, [k], daysAgo(1), o as never), /timeout/, JSON.stringify(o));
  assert.equal(await count("health_samples", k), 1, "nothing was removed");
});

// Free space only (decision-log D152): the system drive's free-space forecast runs from the daily job and raises, then resolves, its alert;
// SMART is gone. An agent before D152 still sends its drives' SMART report on a heartbeat and a smart_warning event: both are accepted and
// neither is kept or alerted on, and nothing issues the two SMART reads again. Migration 0040 dropped the drive history.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envelopes } from "../src/contracts.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { storeEvents } from "../src/services/events.js";
import { issueCommand, RETIRED_OPERATIONS } from "../src/services/commands.js";
import { forecastFleet } from "../src/services/disk-forecast.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let user: string;
test.before(async () => {
  db = await createTestDatabase();
  user = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, $2, 'Tester', 'tier1', 'x')", [user, `t.${user.slice(0, 8)}`]);
});
test.after(async () => { await db?.drop(); });

async function cabinet(): Promise<string> {
  const client = randomUUID(), site = randomUUID(), k = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [k, site]);
  return k;
}
/** 56 samples six hours apart, the newest `newestHoursAgo` ago, with free space given by the hours since. */
const samples = (k: string, free: string, newestHoursAgo = 3) => db.app.query(
  `INSERT INTO health_samples (cabinet_id, [at], cpu_percent, memory_used_percent, disk_free_percent)
   SELECT $1, DATEADD(hour, -h, SYSUTCDATETIME()), 10, 40, ${free} FROM (SELECT TOP (56) $2 + (ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1) * 6 AS h
     FROM sys.all_objects a CROSS JOIN sys.all_objects b) x`, [k, newestHoursAgo]);
const forecast = async (k: string) => (await db.app.query<{ title: string; state: string }>(
  "SELECT title, state FROM alerts WHERE cabinet_id = $1 AND signature = 'disk-forecast'", [k])).rows;

test("the daily job forecasts each reporting cabinet: a drive filling at a steady rate raises one alert, and it resolves once it stops, audited", async () => {
  const filling = await cabinet(), quiet = await cabinet();
  await samples(filling, "CAST(ROUND(40 + h / 24.0 * 2.5, 0) AS int)");   // 40% free now, falling 2.5 points a day
  await samples(quiet, "60");
  assert.ok(await forecastFleet(db.app) >= 2);
  const raised = await forecast(filling);
  assert.equal(raised.length, 1);
  assert.match(raised[0]!.title, /filling up: about \d+ days/);
  assert.deepEqual(await forecast(quiet), [], "a steady drive raises nothing");
  await forecastFleet(db.app);
  assert.equal((await forecast(filling)).length, 1, "a second run is the same alert");

  await db.app.query("DELETE FROM health_samples WHERE cabinet_id = $1", [filling]);
  await samples(filling, "55");
  const alertId = (await db.app.query<{ id: string }>("SELECT id FROM alerts WHERE cabinet_id = $1 AND signature = 'disk-forecast'", [filling])).rows[0]!.id;
  await forecastFleet(db.app);
  assert.equal((await forecast(filling))[0]!.state, "resolved");
  const audited = (await db.app.query<{ actor_kind: string; details: Record<string, unknown> }>(
    "SELECT actor_kind, details FROM audit_log WHERE action = 'alert.resolve' AND target_kind = 'alert' AND target_id = $1", [alertId.toLowerCase()])).rows;
  assert.equal(audited.length, 1);
  assert.equal(audited[0]!.actor_kind, "system");
  assert.equal(audited[0]!.details.automatic, true);
});

test("a cabinet that has not reported for two days, or was removed, is not forecast", async () => {
  const silent = await cabinet(), gone = await cabinet();
  await samples(silent, "CAST(ROUND(40 + h / 24.0 * 2.5, 0) AS int)", 72);
  await samples(gone, "CAST(ROUND(40 + h / 24.0 * 2.5, 0) AS int)");
  await db.app.query("UPDATE cabinets SET status = 'removed' WHERE id = $1", [gone]);
  await forecastFleet(db.app);
  assert.deepEqual([await forecast(silent), await forecast(gone)], [[], []]);
});

test("an agent before D152: its heartbeat's SMART report and its smart_warning event are accepted, and nothing is kept or alerted on", async () => {
  const k = await cabinet();
  const drive = { model: "WD Blue 1TB", serialNumber: "WD-1", health: "failing", predictFailure: true, temperatureCelsius: 36, powerOnHours: 12000,
    reallocatedSectors: 40, pendingSectors: 3, uncorrectableErrors: 1, wearPercent: null };
  const hb = envelopes.heartbeat.parse({ agentVersion: "0.3.1", uptimeSeconds: 100, readOnlyMode: false, health: { cpuPercent: 10, memoryUsedPercent: 40, diskFreePercent: 50, drives: [drive] } });
  await recordHeartbeat(db.app, k, hb);
  const batch = envelopes.eventBatch.parse({ events: [{ eventId: randomUUID(), kind: "smart_warning", occurredAt: new Date().toISOString(), severityHint: "major",
    detail: { message: "Drive predicts failure.", fields: { model: "WD Blue 1TB" } } }] });
  const r = await storeEvents(db.app, k, batch);
  assert.equal(r.stored, 0);
  assert.equal((await db.app.query("SELECT 1 FROM events WHERE cabinet_id = $1 AND kind = 'smart_warning'", [k])).rowCount, 0);
  assert.equal((await db.app.query("SELECT 1 FROM alerts WHERE cabinet_id = $1", [k])).rowCount, 0, "no drive alert and no unrecognized one");
});

test("nothing issues the SMART reads again, and migration 0040 dropped the drive history and disabled the SMART rule", async () => {
  const k = await cabinet();
  assert.deepEqual([...RETIRED_OPERATIONS].sort(), ["disk.smart", "storage.health"]);
  for (const op of RETIRED_OPERATIONS)
    await assert.rejects(issueCommand(db.app, user, k, op, {}), (e: { code?: string }) => e.code === "unknown_operation", op);
  assert.equal((await db.app.query("SELECT 1 FROM commands WHERE cabinet_id = $1", [k])).rowCount, 0);
  assert.equal((await db.app.query("SELECT OBJECT_ID('drive_samples') AS a, OBJECT_ID('drive_status') AS b")).rows[0].a, null);
  assert.equal((await db.app.query("SELECT OBJECT_ID('drive_status') AS b")).rows[0].b, null);
  assert.equal((await db.app.query("SELECT state FROM symptom_rules WHERE id = '00000000-0000-4000-8000-000000000202'")).rows[0].state, "disabled");
  assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM settings WHERE [key] LIKE 'drives.%'")).rows[0].n, 0);
});

test("no CI workflow issues a retired read: the server would refuse it and the Windows run would fail", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".github", "workflows");
  const files = readdirSync(dir).filter(f => f.endsWith(".yml"));
  assert.ok(files.length > 0, "the workflows were read");
  for (const f of files) for (const op of RETIRED_OPERATIONS)
    assert.equal(readFileSync(join(dir, f), "utf8").includes(`'${op}'`), false, `${f} issues ${op}`);
});

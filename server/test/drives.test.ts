// Drive failure prediction end to end on the server: the daily report from a heartbeat is stored, judged against the drive's own history,
// raises an alert only when the level rises, and shows in the cabinet's drive history and in the fleet's list of drives to look at.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { enableDemo } from "../src/demo/demo.js";
import { envelopes } from "../src/contracts.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { ConsoleHarness, ORIGIN } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);

test.before(async () => {
  db = await createTestDatabase();
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  const owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

const cab = async (name: string) => (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = $1 AND demo_scenario IS NOT NULL", [name])).rows[0]!.id;
const drive = (o: Record<string, unknown> = {}) => ({ model: "WD Blue 1TB", serialNumber: "WD-TEST-001", health: "healthy", predictFailure: false, temperatureCelsius: 36, powerOnHours: 12000,
  reallocatedSectors: 0, pendingSectors: 0, uncorrectableErrors: 0, wearPercent: null, ...o });
const heartbeat = (cabinetId: string, drives: unknown[]) => recordHeartbeat(db.app, cabinetId, envelopes.heartbeat.parse({ agentVersion: "1.4.2", uptimeSeconds: 100, readOnlyMode: false,
  health: { cpuPercent: 10, memoryUsedPercent: 40, diskFreePercent: 50, drives } }));
/** The simulated fleet comes with a month of history; these tests start a drive's history from nothing. */
const clean = async (cabinetId: string) => { for (const t of ["drive_samples", "drive_status"]) await db.app.query(`DELETE FROM ${t} WHERE cabinet_id = $1`, [cabinetId]); };
const alertsFor = async (cabinetId: string) => (await db.app.query<{ title: string; severity: string; occurrences: number; state: string }>(
  "SELECT title, severity, occurrences, state FROM alerts WHERE cabinet_id = $1 AND signature LIKE 'drive-trend:%'", [cabinetId])).rows;

test("the simulated fleet has three drives with trends the platform catches early, each at the level its history earns", async () => {
  const t1 = await h.account("tier1");
  const risk = (await h.call("GET", "/api/fleet/drives-at-risk", undefined, t1)).body.drives as { cabinet: string; level: string; reasons: string[] }[];
  const by = Object.fromEntries(risk.map(r => [r.cabinet, r]));
  assert.equal(by.Surgery?.level, "urgent");
  assert.match(by.Surgery!.reasons.join(" "), /reallocated sectors/);
  assert.equal(by.Lab?.level, "act");
  assert.match(by.Lab!.reasons.join(" "), /rated life/);
  assert.equal(by.ICU?.level, "watch");
  assert.equal(risk.length, 3, "every other drive is fine and is not listed");
  assert.equal(risk[0]!.cabinet, "Surgery", "the worst first");
  // Urgent and act raise alerts; watch does not.
  assert.deepEqual((await alertsFor(await cab("Surgery"))).map(a => a.severity), ["major"]);
  assert.deepEqual((await alertsFor(await cab("Lab"))).map(a => a.severity), ["minor"]);
  assert.deepEqual(await alertsFor(await cab("ICU")), []);
  const history = (await h.call("GET", `/api/cabinets/${await cab("Surgery")}/drives`, undefined, t1)).body.drives[0];
  assert.equal(history.level, "urgent");
  assert.equal(history.history.length, 30);
  assert.ok(history.latest.reallocated > 20);
});

test("a heartbeat's drive report is stored once per 12 hours and a drive that predicts failure raises one major alert, however often it is reported", async () => {
  const id = await cab("Exam Room 1");
  await clean(id);
  await heartbeat(id, [drive()]);
  assert.equal((await db.app.query("SELECT 1 FROM drive_samples WHERE cabinet_id = $1", [id])).rowCount, 1);
  assert.deepEqual(await alertsFor(id), [], "a healthy drive raises nothing");
  await heartbeat(id, [drive()]);
  assert.equal((await db.app.query("SELECT 1 FROM drive_samples WHERE cabinet_id = $1", [id])).rowCount, 1, "a repeat within 12 hours adds nothing");
  // Thirteen hours later it predicts failure.
  await db.app.query("UPDATE drive_samples SET at = at - interval '13 hours' WHERE cabinet_id = $1", [id]);
  await heartbeat(id, [drive({ predictFailure: true, health: "failing" })]);
  let alerts = await alertsFor(id);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "major");
  assert.match(alerts[0]!.title, /WD Blue/);
  // Another day, same state: the level did not rise, so the alert is not raised again.
  await db.app.query("UPDATE drive_samples SET at = at - interval '13 hours' WHERE cabinet_id = $1", [id]);
  await heartbeat(id, [drive({ predictFailure: true, health: "failing" })]);
  alerts = await alertsFor(id);
  assert.equal(alerts.length, 1); assert.equal(alerts[0]!.occurrences, 1);
});

test("a drive whose bad sectors start to grow climbs from watch to act on its own history, and a drive reporting nothing is not a concern", async () => {
  const id = await cab("Exam Room 2");
  await clean(id);
  const day = async (n: number, d: Record<string, unknown>) => {
    await db.app.query("UPDATE drive_samples SET at = at - interval '1 day' WHERE cabinet_id = $1", [id]);
    await heartbeat(id, [drive(d)]);
    return (await db.app.query<{ level: string }>("SELECT level FROM drive_status WHERE cabinet_id = $1", [id])).rows[0]!.level;
  };
  assert.equal(await day(0, { reallocatedSectors: 0 }), "ok");
  for (let i = 0; i < 10; i++) await day(i, { reallocatedSectors: 0 });
  assert.equal(await day(11, { reallocatedSectors: 4 }), "act", "4 new reallocated sectors within a week");
  const blank = await cab("Exam Room 3");
  await clean(blank);
  await heartbeat(blank, [{ model: null, serialNumber: null, health: "unknown", predictFailure: null, temperatureCelsius: null, powerOnHours: null, reallocatedSectors: null, pendingSectors: null, uncorrectableErrors: null, wearPercent: null }]);
  assert.equal((await db.app.query<{ level: string }>("SELECT level FROM drive_status WHERE cabinet_id = $1", [blank])).rows[0]!.level, "ok");
});

test("hostile or malformed drive reports are refused by the heartbeat contract before anything is stored", () => {
  const base = { agentVersion: "1.4.2", uptimeSeconds: 1, readOnlyMode: false };
  const health = (drives: unknown) => ({ ...base, health: { cpuPercent: 1, memoryUsedPercent: 1, diskFreePercent: 1, drives } });
  for (const bad of [[drive({ health: "dying" })], [drive({ command: "format c:" })], [drive({ temperatureCelsius: 9999 })], [drive({ wearPercent: 101 })], [drive({ reallocatedSectors: -1 })],
    [drive({ model: "a\nb" })], [drive({ model: "x".repeat(300) })], Array.from({ length: 33 }, () => drive())])
    assert.throws(() => envelopes.heartbeat.parse(health(bad)), JSON.stringify(bad).slice(0, 80));
});

test("a system drive that is filling at a steady rate raises a forecast alert weeks before it is full", async () => {
  const id = await cab("Reception");
  await db.app.query("DELETE FROM health_samples WHERE cabinet_id = $1", [id]);
  // 14 days, every 5 minutes would be 4,032 rows: one every 6 hours is enough to show the slope; free space 40% falling 2.5 points a day.
  await db.app.query(`INSERT INTO health_samples (cabinet_id, at, cpu_percent, memory_used_percent, disk_free_percent)
                      SELECT $1, now() - make_interval(hours => h), 10, 40, (40 + h / 24.0 * 2.5)::int FROM generate_series(0, 335, 6) h`, [id]);
  await db.app.query("DELETE FROM health_samples WHERE cabinet_id = $1 AND at < now() - interval '14 days'", [id]);
  const more = await db.app.query(`INSERT INTO health_samples (cabinet_id, at, cpu_percent, memory_used_percent, disk_free_percent)
                      SELECT $1, now() - make_interval(mins => m), 10, 40, 40 FROM generate_series(1, 60, 1) m ON CONFLICT DO NOTHING`, [id]);
  assert.ok((more.rowCount ?? 0) > 0);
  await db.app.query("DELETE FROM health_samples WHERE cabinet_id = $1 AND at > now() - interval '2 hours'", [id]);
  await heartbeat(id, [drive({ serialNumber: "WD-TEST-REC" })]);
  const forecast = (await db.app.query<{ title: string }>("SELECT title FROM alerts WHERE cabinet_id = $1 AND signature = 'disk-forecast'", [id])).rows;
  assert.equal(forecast.length, 1);
  assert.match(forecast[0]!.title, /filling up: about \d+ days/);
});

test("two drives with no serial number keep separate histories, and an empty serial is treated as none", async () => {
  const id = await cab("Check-in");
  await clean(id);
  const bare = { serialNumber: "", model: "Generic SSD" };
  await heartbeat(id, [drive({ ...bare, predictFailure: true, health: "failing" }), drive({ ...bare })]);
  const status = (await db.app.query<{ drive_key: string; level: string }>("SELECT drive_key, level FROM drive_status WHERE cabinet_id = $1 ORDER BY drive_key", [id])).rows;
  assert.deepEqual(status, [{ drive_key: "Generic SSD#0", level: "urgent" }, { drive_key: "Generic SSD#1", level: "ok" }]);
});

test("the disk-filling forecast resolves itself once the system drive stops filling", async () => {
  const id = await cab("Reception");
  assert.equal((await db.app.query("SELECT 1 FROM alerts WHERE cabinet_id = $1 AND signature = 'disk-forecast' AND state <> 'resolved'", [id])).rowCount, 1, "from the previous test");
  await db.app.query("DELETE FROM health_samples WHERE cabinet_id = $1", [id]);
  await db.app.query(`INSERT INTO health_samples (cabinet_id, at, cpu_percent, memory_used_percent, disk_free_percent)
                      SELECT $1, now() - make_interval(hours => h), 10, 40, 55 FROM generate_series(3, 335, 6) h`, [id]);
  await heartbeat(id, [drive({ serialNumber: "WD-TEST-REC" })]);
  assert.equal((await db.app.query("SELECT 1 FROM alerts WHERE cabinet_id = $1 AND signature = 'disk-forecast' AND state <> 'resolved'", [id])).rowCount, 0);
});

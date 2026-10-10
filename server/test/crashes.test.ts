// Crash investigation (docs/spec/13-roadmap.md phase 2): stop codes read from BugCheck messages without patterns, boots
// from heartbeats and change events, reboot loops (and not every quiet cabinet), the timeline of what changed before a
// crash, and the fleet incident view that compares the cabinets that crashed with the ones that did not.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { storeEvents } from "../src/services/events.js";
import { categorize, changeKey, checkQuietLoops, describeStopCode, stopCodeOf } from "../src/services/crashes.js";
import { enableDemo, INCIDENT_DRIVER, INCIDENT_UPDATE } from "../src/demo/demo.js";
import { ISSUE } from "../src/services/rules.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
let adminId: string, cabinetId: string, cookie: string;

async function call(url: string, c: string | null = cookie) {
  const r = await app.inject({ method: "GET", url, headers: { origin: ORIGIN, ...(c ? { cookie: c } : {}) } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
const loopAlert = async (id: string) => (await db.app.query<{ state: string; title: string }>(
  "SELECT state, title FROM alerts WHERE cabinet_id = $1 AND signature = 'reboot_loop' ORDER BY (state <> 'resolved') DESC, first_seen DESC LIMIT 1", [id])).rows[0];
const heartbeat = (uptimeSeconds: number) => recordHeartbeat(db.app, cabinetId, { agentVersion: "1.4.2", uptimeSeconds, readOnlyMode: false });

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock });
  adminId = randomUUID();
  const secret = totp.newSecret();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, 'sam', 'Sam', 'tier1', $2, false, true, $3)`,
    [adminId, await hashPassword("correct horse battery staple"), secrets.seal(secret)]);
  const { token } = await createBootstrapToken(db.app, adminId);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
    hostname: "CAB-1", serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 10", agentVersion: "1.4.2" } }, "127.0.0.1");
  cabinetId = (await approveEnrollment(db.app, key, requestId, { clientName: "Acme", siteName: "North", cabinetName: "ICU", role: "standalone" }, adminId)).cabinetId;
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: "sam", password: "correct horse battery staple" }) });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  clock += 30_000;
  await app.inject({ method: "POST", url: "/api/auth/totp", headers: { origin: ORIGIN, cookie, "content-type": "application/json" }, payload: JSON.stringify({ code: totp.code(secret, totp.stepAt(clock)) }) });
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

test("stop codes come from the BugCheck message without patterns; anything odd is unknown, never guessed", () => {
  const m = (code: string) => `The computer has rebooted from a bugcheck.  The bugcheck was: ${code} (0x0000000000000028, 0x2). A dump was saved in: C:\\Windows\\MEMORY.DMP.`;
  assert.equal(stopCodeOf(m("0x000000d1")), 0xD1);
  assert.equal(stopCodeOf(m("0x0000007E")), 0x7E);
  assert.equal(stopCodeOf(m("0xc000021a")), 0xC000021A);
  assert.deepEqual(describeStopCode(stopCodeOf(m("0x000000d1"))), { code: 0xD1, text: "0x000000D1", name: "DRIVER_IRQL_NOT_LESS_OR_EQUAL", hint: "A driver, very often a recently installed or updated one." });
  for (const bad of ["", "no marker here", m("0x"), m("d1"), m("0x0000000000000000d1"), m("0xZZ"), "the bugcheck was: 0x", "THE BUGCHECK WAS: ".repeat(1000), m("０x00d1")])
    assert.equal(stopCodeOf(bad), null, bad.slice(0, 60));
  assert.deepEqual(describeStopCode(0x12345), { code: 0x12345, text: "0x00012345", name: null, hint: null });
});

test("changes are named the same way on every cabinet, so the fleet can count them", () => {
  assert.equal(changeKey("update_installed", `Installation Successful: Windows successfully installed the following update: ${INCIDENT_UPDATE}`), INCIDENT_UPDATE);
  assert.equal(changeKey("driver_installed", `Driver Management concluded the process to install driver ${INCIDENT_DRIVER} for Device Instance ID PCI\\X with the following status: 0x0.`), `Driver ${INCIDENT_DRIVER}`);
  assert.equal(changeKey("software_installed", "Product: Scanner Suite 4.2 -- Installation completed successfully."), "Scanner Suite 4.2 installed");
  assert.equal(changeKey("update_installed", "x".repeat(1000)).length, 160);
  assert.equal(categorize({ kind: "error", source: { log: "System", source: "BUGCHECK", eventId: 1001 }, message: "", fields: null })?.category, "crash");
  assert.equal(categorize({ kind: "change", source: { log: "System", source: "EventLog", eventId: 6005 }, message: "", fields: null }), null, "the same boot as Kernel-General 12");
  assert.equal(categorize({ kind: "error", source: { log: "System", source: "Something", eventId: 1 }, message: "", fields: null })?.category, "error");
});

test("boots: from the heartbeat's uptime and from Windows' own start record, counted once; 3 in an hour is a reboot loop, 2 hours up ends it", async () => {
  await heartbeat(50_000);
  await heartbeat(50_060);                                  // same boot
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM cabinet_boots WHERE cabinet_id = $1", [cabinetId])).rows[0].n, 1);
  // Windows' own start record for that same boot is not a second boot.
  const booted = new Date(Date.now() - 50_060_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  await storeEvents(db.app, cabinetId, { events: [{ eventId: randomUUID(), kind: "change", occurredAt: booted, severityHint: "minor",
    source: { log: "System", source: "Microsoft-Windows-Kernel-General", eventId: 12, level: "information", recordId: 1 }, detail: { message: "The operating system started." } }] });
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM cabinet_boots WHERE cabinet_id = $1", [cabinetId])).rows[0].n, 1);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM alerts WHERE cabinet_id = $1", [cabinetId])).rows[0].n, 0, "a change never raises an alert");
  await heartbeat(240);                                      // restarted
  assert.equal(await loopAlert(cabinetId), undefined, "two starts are not a loop");
  // Another start 40 minutes ago (seen by Windows' own record), then a third now: 3 within the hour.
  await db.app.query("INSERT INTO cabinet_boots (cabinet_id, booted_at, source) VALUES ($1, now() - interval '40 minutes', 'event')", [cabinetId]);
  await heartbeat(30);
  const alert = (await loopAlert(cabinetId))!;
  assert.equal(alert.state, "open");
  assert.match(alert.title, /Restarting repeatedly \(possible reboot loop\): 3 starts within an hour/);
  assert.equal((await db.app.query("SELECT severity FROM alerts WHERE cabinet_id = $1 AND signature = 'reboot_loop'", [cabinetId])).rows[0].severity, "major");
  await heartbeat(2 * 3600 + 5);
  assert.equal((await loopAlert(cabinetId))!.state, "resolved");
});

test("a cabinet that restarted and went quiet is a reboot loop; one that simply went offline is not", async () => {
  await db.app.query("DELETE FROM cabinet_boots WHERE cabinet_id = $1", [cabinetId]);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = now() - interval '2 hours', uptime_seconds = 50000 WHERE id = $1", [cabinetId]);
  assert.equal(await checkQuietLoops(db.app), 0, "quiet after a long uptime: plain offline");
  await db.app.query("INSERT INTO cabinet_boots (cabinet_id, booted_at, source) VALUES ($1, now() - interval '150 minutes', 'heartbeat'), ($1, now() - interval '125 minutes', 'heartbeat')", [cabinetId]);
  await db.app.query("UPDATE cabinets SET uptime_seconds = 300 WHERE id = $1", [cabinetId]);
  assert.equal(await checkQuietLoops(db.app), 1);
  assert.match((await loopAlert(cabinetId))!.title, /started 2 times, then went quiet/);
  assert.equal(await checkQuietLoops(db.app), 0, "raised once");
});

test("hostile or out-of-range windows are refused before any query runs", async () => {
  for (const q of ["days=1000", "days=7&sql=1", "from=yesterday", "from=2026-10-09T00:00:00Z&to=2026-10-01T00:00:00Z", "from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z", "clientId=../../x", "days=30", "days=90"])
    assert.equal((await call(`/api/incidents/crashes?${q}`)).status, 400, q);
  assert.equal((await call("/api/incidents/crashes", null)).status, 401);
  assert.equal((await call(`/api/cabinets/${randomUUID()}/crashes`)).status, 404);
});

test("the overnight incident: who crashed, when it began, the stop code, who is still restarting, and the driver that stands out", async () => {
  await enableDemo(db.app, adminId);
  const r = await call("/api/incidents/crashes?days=3");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const inc = r.body;
  const harbor = inc.cabinetsAffected.filter((c: { client: string }) => c.client === "Demo · Harbor Pet Hospitals");
  assert.equal(harbor.length, 60, "60 of the 80 Harbor cabinets crashed");
  assert.equal(harbor.filter((c: { rebootLoop: boolean }) => c.rebootLoop).length, 12, "12 are still restarting");
  assert.equal(harbor.filter((c: { online: boolean }) => !c.online).length, 12);
  assert.equal(inc.stopCodes[0].stopCode.text, "0x000000D1");
  assert.equal(inc.stopCodes[0].cabinets, 60);
  const driver = inc.comparisons.find((c: { change: string }) => c.change === `Driver installed: Driver ${INCIDENT_DRIVER}`);
  const update = inc.comparisons.find((c: { change: string }) => c.change === `Update installed: ${INCIDENT_UPDATE}`);
  assert.ok(driver && update, JSON.stringify(inc.comparisons.map((c: { change: string }) => c.change)));
  assert.equal(driver.affected, 60);
  assert.equal(driver.unaffected, 2, "two cabinets got the driver and did not crash");
  assert.equal(driver.standsOut, true);
  assert.equal(update.affected, 60);
  assert.ok(update.unaffected > 20, "nearly every cabinet got the update, so it does not distinguish them");
  assert.equal(update.standsOut, false);
  assert.equal(inc.comparisons[0].change, driver.change, "what stands out comes first");
  assert.ok(inc.onset.length >= 1 && inc.firstAt <= inc.lastAt);
  // One crashed cabinet: what changed in the 72 hours before its first blue screen.
  const one = harbor.find((c: { rebootLoop: boolean }) => !c.rebootLoop);
  const d = (await call(`/api/cabinets/${one.id}/crashes?days=7`)).body;
  assert.equal(d.crashes, 1);
  assert.equal(d.stopCodes[0].stopCode.name, "DRIVER_IRQL_NOT_LESS_OR_EQUAL");
  const before = d.beforeFirst.map((i: { title: string }) => i.title);
  assert.ok(before.includes(`Update installed: ${INCIDENT_UPDATE}`) && before.includes(`Driver installed: Driver ${INCIDENT_DRIVER}`), JSON.stringify(before));
  assert.ok(d.timeline.some((i: { category: string }) => i.category === "boot"));
  // The loop cabinets have their reboot-loop alert.
  const loop = harbor.find((c: { rebootLoop: boolean }) => c.rebootLoop);
  assert.equal((await db.app.query("SELECT issue_type_id FROM alerts WHERE cabinet_id = $1 AND signature = 'reboot_loop'", [loop.id])).rows[0].issue_type_id, ISSUE.rebootLoop);
});

// Crash investigation (docs/spec/13-roadmap.md phase 2): stop codes read from BugCheck messages without patterns, boots
// from heartbeats and change events, reboot loops (and not every quiet cabinet), the timeline of what changed before a
// crash, and the fleet incident view that compares the cabinets that crashed with the ones that did not.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { storeEvents } from "../src/services/events.js";
import { BUG_CHECK_PAIR_MS, categorize, causeFromFields, changeKey, checkQuietLoops, classifyShutdowns, describeStopCode, stopCodeOf, type TimelineItem } from "../src/services/crashes.js";
import { enableDemo, INCIDENT_DRIVER, INCIDENT_UPDATE } from "../src/demo/demo.js";
import { verifyEvidence } from "../src/services/evidence.js";
import { decryptEvidence } from "../src/services/evidence-crypto.js";
import { ISSUE } from "../src/services/rules.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
let adminId: string, cabinetId: string, cookie: string;

async function call(url: string, c: string | null = cookie) {
  const r = await app.inject({ method: "GET", url, headers: { origin: ORIGIN, ...(c ? { cookie: c } : {}) } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
const loopAlert = async (id: string) => (await db.app.query<{ state: string; title: string }>(
  "SELECT state, title FROM alerts WHERE cabinet_id = $1 AND signature = 'reboot_loop' ORDER BY CASE WHEN state <> 'resolved' THEN 0 ELSE 1 END, first_seen DESC OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY", [id])).rows[0];
const heartbeat = (uptimeSeconds: number) => recordHeartbeat(db.app, cabinetId, { agentVersion: "1.4.2", uptimeSeconds, readOnlyMode: false });

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock });
  adminId = randomUUID();
  const secret = totp.newSecret();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, 'sam', 'Sam', 'tier1', $2, 0, 1, $3)`,
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
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

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
  assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM cabinet_boots WHERE cabinet_id = $1", [cabinetId])).rows[0].n, 1);
  // Windows' own start record for that same boot is not a second boot.
  const booted = new Date(Date.now() - 50_060_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  await storeEvents(db.app, cabinetId, { events: [{ eventId: randomUUID(), kind: "change", occurredAt: booted, severityHint: "minor",
    source: { log: "System", source: "Microsoft-Windows-Kernel-General", eventId: 12, level: "information", recordId: 1 }, detail: { message: "The operating system started." } }] });
  assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM cabinet_boots WHERE cabinet_id = $1", [cabinetId])).rows[0].n, 1);
  assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM alerts WHERE cabinet_id = $1", [cabinetId])).rows[0].n, 0, "a change never raises an alert");
  await heartbeat(240);                                      // restarted
  assert.equal(await loopAlert(cabinetId), undefined, "two starts are not a loop");
  // Another start 40 minutes ago (seen by Windows' own record), then a third now: 3 within the hour.
  await db.app.query("INSERT INTO cabinet_boots (cabinet_id, booted_at, source) VALUES ($1, DATEADD(minute, -40, SYSUTCDATETIME()), 'event')", [cabinetId]);
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
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -2, SYSUTCDATETIME()), uptime_seconds = 50000 WHERE id = $1", [cabinetId]);
  assert.equal(await checkQuietLoops(db.app), 0, "quiet after a long uptime: plain offline");
  await db.app.query("INSERT INTO cabinet_boots (cabinet_id, booted_at, source) VALUES ($1, DATEADD(minute, -150, SYSUTCDATETIME()), 'heartbeat'), ($1, DATEADD(minute, -125, SYSUTCDATETIME()), 'heartbeat')", [cabinetId]);
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
  // Its unexpected restart is the blue screen's own Kernel-Power 41, logged half a minute before it: a bug check, not a power cut.
  assert.deepEqual(d.shutdownCauses, { bugCheck: d.unexpectedShutdowns, forcedOff: 0, powerLossOrHang: 0 });
  assert.ok(d.unexpectedShutdowns >= 1);
  const before = d.beforeFirst.map((i: { title: string }) => i.title);
  assert.ok(before.includes(`Update installed: ${INCIDENT_UPDATE}`) && before.includes(`Driver installed: Driver ${INCIDENT_DRIVER}`), JSON.stringify(before));
  assert.ok(d.timeline.some((i: { category: string }) => i.category === "boot"));
  // The loop cabinets have their reboot-loop alert.
  const loop = harbor.find((c: { rebootLoop: boolean }) => c.rebootLoop);
  assert.equal((await db.app.query("SELECT issue_type_id FROM alerts WHERE cabinet_id = $1 AND signature = 'reboot_loop'", [loop.id])).rows[0].issue_type_id, ISSUE.rebootLoop);
});

test("an evidence package holds the cabinet's events, boots, alerts, commands and analysis, with provenance and hashes; any change is detected; the export is audited", async () => {
  const one = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario = 'incident_crash' ORDER BY name OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY")).rows[0]!.id;
  const r = await app.inject({ method: "GET", url: `/api/cabinets/${one}/evidence?days=7`, headers: { origin: ORIGIN, cookie } });
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers["content-disposition"]), /^attachment; filename="evidence-[0-9a-f-]{36}-\d{4}-\d{2}-\d{2}\.json"$/);
  const pkg = JSON.parse(r.body);
  assert.equal(pkg.manifest.format, "mashura-cabinet-evidence/1");
  assert.deepEqual(Object.keys(pkg.sections).sort(), ["alerts", "analysis", "boots", "cabinet", "commands", "events", "timeline"]);
  for (const s of Object.values(pkg.sections) as { provenance: string }[]) assert.ok(s.provenance.length > 20);
  const events = pkg.sections.events.items as { kind: string; source: { log: string; recordId: number } | null }[];
  assert.ok(events.some(e => e.kind === "error" && e.source?.recordId), "the original Windows entry is identified");
  assert.ok(pkg.sections.analysis.items.crashes >= 1);
  assert.match(pkg.sections.analysis.provenance, /correlation, not proof/);
  // Integrity: as exported it verifies; one changed character in any section, or in the manifest, does not.
  assert.equal(verifyEvidence(pkg), true);
  const tampered = JSON.parse(r.body);
  tampered.sections.events.items[0].occurredAt = "2020-01-01T00:00:00Z";
  assert.equal(verifyEvidence(tampered), false);
  const relabelled = JSON.parse(r.body);
  relabelled.manifest.exportedBy = "Someone else";
  assert.equal(verifyEvidence(relabelled), false);
  const audited = (await db.app.query("SELECT details FROM audit_log WHERE action = 'evidence.export' AND target_id = $1", [one])).rows;
  assert.equal(audited.length, 1);
  assert.equal(audited[0].details.packageSha256, pkg.manifest.packageSha256);
  // The encrypted export: the same package, opened only with the passphrase; the passphrase is not in the audit entry; weak or hostile requests are refused.
  const pass = "correct horse battery staple";
  const enc = await app.inject({ method: "POST", url: `/api/cabinets/${one}/evidence/encrypted`, headers: { origin: ORIGIN, cookie }, payload: { days: "7", passphrase: pass } });
  assert.equal(enc.statusCode, 200);
  assert.match(String(enc.headers["content-disposition"]), /\.cabev"$/);
  const opened = JSON.parse(decryptEvidence(enc.rawPayload, pass).toString("utf8"));
  assert.equal(verifyEvidence(opened), true);
  assert.throws(() => decryptEvidence(enc.rawPayload, "another passphrase here"));
  assert.ok(!enc.rawPayload.toString("utf8").includes("mashura-cabinet-evidence"), "the file holds no readable package text");
  const encAudit = (await db.app.query("SELECT details FROM audit_log WHERE action = 'evidence.export' AND target_id = $1 ORDER BY seq DESC OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY", [one])).rows[0];
  assert.equal(encAudit.details.encrypted, true);
  assert.ok(!JSON.stringify(encAudit).includes(pass));
  for (const payload of [{ days: "7", passphrase: "short" }, { days: "7" }, { days: "999", passphrase: pass }, { days: "7", passphrase: pass, x: 1 }])
    assert.equal((await app.inject({ method: "POST", url: `/api/cabinets/${one}/evidence/encrypted`, headers: { origin: ORIGIN, cookie }, payload })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/api/cabinets/${one}/evidence/encrypted`, headers: { origin: ORIGIN }, payload: { days: "7", passphrase: pass } })).statusCode, 401);
  // Hostile and unknown requests.
  assert.equal((await call(`/api/cabinets/${randomUUID()}/evidence`)).status, 404);
  for (const q of ["days=1000", "from=2020-01-01T00:00:00Z&to=2026-10-01T00:00:00Z", "days=7&x=1"])
    assert.equal((await call(`/api/cabinets/${one}/evidence?${q}`)).status, 400, q);
  assert.equal((await call(`/api/cabinets/${one}/evidence`, null)).status, 401);
});

test("an unexpected restart's cause: its own fields first, then a blue screen within minutes, else power lost or a hang", () => {
  assert.equal(causeFromFields({ BugcheckCode: "209", PowerButtonTimestamp: "0" }), "bug_check");
  assert.equal(causeFromFields({ BugcheckCode: "0x0", PowerButtonTimestamp: "133457952000000000" }), "forced_off");
  assert.equal(causeFromFields({ BugcheckCode: "0", PowerButtonTimestamp: "0" }), null, "both zero: the fields cannot tell");
  assert.equal(causeFromFields(null), null);
  // Hostile or odd values are not numbers, so they never decide a cause.
  for (const v of ["", " ", "0x", "zz", "-1", "1e5", "0x" + "f".repeat(30), "１２", "209; DROP TABLE events", "NaN", "Infinity"])
    assert.equal(causeFromFields({ BugcheckCode: v }), null, JSON.stringify(v));
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 1) + ms).toISOString();
  const shutdown = (ms: number, cause?: TimelineItem["cause"]): TimelineItem => ({ at: at(ms), category: "unexpected_shutdown", title: "Restarted without shutting down cleanly", detail: "", ...(cause ? { cause } : {}) });
  const crash = (ms: number): TimelineItem => ({ at: at(ms), category: "crash", title: "Blue screen", detail: "" });
  const items = classifyShutdowns([shutdown(0), crash(90_000), shutdown(3_600_000), crash(3_600_000 + BUG_CHECK_PAIR_MS + 1_000), shutdown(7_200_000, "forced_off")]);
  const causes = items.filter(i => i.category === "unexpected_shutdown").map(i => i.cause);
  assert.deepEqual(causes, ["bug_check", "power_loss_or_hang", "forced_off"], "paired within the window, not beyond it; a cause from fields stands");
  assert.match(items[0]!.title, /after a blue screen/);
  assert.match(items[2]!.title, /power lost, or Windows froze/);
});

test("the cabinet's crash view counts unexpected restarts by cause, from what the cabinet reported", async () => {
  const [client, site, k] = [randomUUID(), randomUUID(), randomUUID()];
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Power ${randomBytes(3).toString("hex")}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'POWER TEST', 'standalone', 'active')", [k, site]);
  const when = (hoursAgo: number, plusMs = 0) => new Date(Math.floor((Date.now() - hoursAgo * 3_600_000 + plusMs) / 1000) * 1000).toISOString().split(".")[0] + "Z";
  let rec = 100;
  const kp41 = (t: string, fields?: Record<string, string>) => ({ eventId: randomUUID(), kind: "error" as const, occurredAt: t, severityHint: "major" as const,
    source: { log: "System" as const, source: "Microsoft-Windows-Kernel-Power", eventId: 41, level: "critical" as const, recordId: rec++ },
    detail: { message: "The system has rebooted without cleanly shutting down first.", ...(fields ? { fields } : {}) } });
  const bugcheck = (t: string) => ({ eventId: randomUUID(), kind: "error" as const, occurredAt: t, severityHint: "major" as const,
    source: { log: "System" as const, source: "BugCheck", eventId: 1001, level: "error" as const, recordId: rec++ },
    detail: { message: "The computer has rebooted from a bugcheck.  The bugcheck was: 0x000000d1 (0x0, 0x2, 0x0, 0x0). A dump was saved in: C:\\Windows\\MEMORY.DMP." } });
  await storeEvents(db.app, k, { events: [
    kp41(when(70)),                                                             // nothing else: power or a hang
    kp41(when(50), { BugcheckCode: "0", PowerButtonTimestamp: "133457952000000000" }), // the button was held
    kp41(when(30)), bugcheck(when(30, 90_000)),                                 // a blue screen logged on the next start
    kp41(when(10), { BugcheckCode: "209", PowerButtonTimestamp: "0" }),          // the event names its own bug check
  ] });
  const d = (await call(`/api/cabinets/${k}/crashes?days=7`)).body;
  assert.equal(d.unexpectedShutdowns, 4);
  assert.deepEqual(d.shutdownCauses, { bugCheck: 2, forcedOff: 1, powerLossOrHang: 1 });
  const titles = (d.timeline as { category: string; title: string }[]).filter(i => i.category === "unexpected_shutdown").map(i => i.title);
  assert.ok(titles.some(t => t.includes("power button was held")), JSON.stringify(titles));
});

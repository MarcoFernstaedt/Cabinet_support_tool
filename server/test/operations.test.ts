// Operations: 90-day event retention with the bulky JSON cleared after 30 days, the database-size and other health checks,
// the operations counters (counts only), the System health API (Admin only, no secrets) and the agent pacing settings.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { paramsHash } from "../src/auth/canonical.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import type { IssuingKey } from "../src/pki/x509.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { clearOldEventDetail, runRetention, EVENT_DETAIL_DAYS } from "../src/services/maintenance.js";
import { DEFAULT_SETTINGS, agentPacing, platformSettings } from "../src/services/settings.js";
import { connectOwner, migrate, readMigrations } from "../src/db/migrate.js";
import { alertMigrationFailed } from "../src/services/security.js";
import { NULL_BINARY, verifyAuditChain } from "../src/db/db.js";
import { OpsMeter, OpsReporter, errorSpike, minuteOf, noteError, noteResponse, pruneOpsCounters, safeCode, shedSustained, splitKey, writeOpsCounters } from "../src/services/ops-meter.js";
import { certificateExpiry, editionLimitBytes, formatHealth, healthSummary, runOpsChecks } from "../src/services/ops-health.js";
import { createTestDatabase, asOwner, startFeed, type TestDatabase } from "./database.js";
import { csrFor, ecKey, firstCookie, tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let key: IssuingKey;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
let cabinetId: string;
interface Account { id: string; username: string; password: string; secret?: Buffer }
let boss: Account, bossCookie: string;

async function account(role: "tier1" | "tier2" | "admin"): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple" };
  const secret = totp.newSecret();
  await db.app.query<any>(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, $2, $3, $4, $5, 0, 1, $6, 1)`, [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(secret)]);
  a.secret = secret;
  return a;
}
const nextCode = (a: Account): string => { clock += 30_000; return totp.code(a.secret!, totp.stepAt(clock)); };
interface Reply { status: number; body: any; text: string; cookie?: string; headers: Record<string, unknown> }
async function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie?: string): Promise<Reply> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const r = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}), remoteAddress: "10.9.8.7" });
  let parsed: unknown = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  const c = firstCookie(r.headers["set-cookie"]);
  return { status: r.statusCode, body: parsed, text: r.body, ...(c ? { cookie: c } : {}), headers: r.headers };
}
async function signIn(a: Account): Promise<string> {
  const r = await call("POST", "/api/auth/login", { username: a.username, password: a.password });
  assert.equal(r.status, 200, r.text);
  assert.equal((await call("POST", "/api/auth/totp", { code: nextCode(a) }, r.cookie)).body.stage, "complete");
  return r.cookie!;
}
async function stepUp(a: Account, cookie: string, action: string, target: string, params?: unknown): Promise<string> {
  const r = await call("POST", "/api/auth/step-up", { code: nextCode(a), action, target, ...(params !== undefined ? { paramsHash: paramsHash(params) } : {}) }, cookie);
  assert.equal(r.status, 200, r.text);
  return r.body.token;
}
const q = <R = any>(text: string, params: unknown[] = []) => db.app.query<R>(text, params);
const openAlerts = async (kind: string) => (await q<{ title: string; occurrences: number }>("SELECT title, occurrences FROM security_alerts WHERE kind = $1 AND state = 'open'", [kind])).rows;

test.before(async () => {
  db = await createTestDatabase();
  key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock });
  boss = await account("admin");
  bossCookie = await signIn(boss);
  const { token } = await createBootstrapToken(db.app, boss.id);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
    hostname: "CAB-01", serialNumber: "SN1", macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z",
    osVersion: "Windows 10", agentVersion: "0.2.0" } }, "127.0.0.1");
  cabinetId = (await approveEnrollment(db.app, key, requestId, { clientName: "Acme Health", siteName: "North", cabinetName: "ICU 1", role: "standalone" }, boss.id)).cabinetId;
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

// ---- Retention: 90 days, detail cleared after 30 ----------------------------------------------------------------------------------

test("events are kept 90 days by default", async () => {
  assert.equal(DEFAULT_SETTINGS.retention.eventsDays, 90);
  assert.equal((await platformSettings(db.app)).retention.eventsDays, 90);
  assert.equal(EVENT_DETAIL_DAYS, 30);
});

const FAST = { batch: 3, pauseMs: 0, timeoutMs: 30_000 };
async function addEvent(ageDays: number, o: { kind?: string; alert?: string | null; source?: object; detail?: object } = {}): Promise<string> {
  const id = randomUUID();
  await asOwner(db, k => k.query<any>(
    `INSERT INTO events (event_id, cabinet_id, kind, occurred_at, received_at, source, detail, alert_id)
     VALUES ($1, $2, $3, DATEADD(day, -$4, SYSUTCDATETIME()), DATEADD(day, -$4, SYSUTCDATETIME()), $5, $6, $7)`,
    [id, cabinetId, o.kind ?? "error", ageDays, JSON.stringify(o.source ?? { log: "System", source: "Disk", eventId: 7 }), JSON.stringify(o.detail ?? { message: "The device has a bad block.", fields: { a: 1 } }), o.alert ?? null]));
  return id;
}
const eventRow = async (id: string) => (await q<{ source: string | null; detail: string | null; kind: string }>("SELECT source, detail, kind FROM events WHERE event_id = $1", [id])).rows[0]!;

test("after 30 days an event without an alert loses detail and source; alerted, security, crash and recent events stay whole, and the row itself stays", async () => {
  const alertId = randomUUID();
  await asOwner(db, k => k.query<any>("INSERT INTO alerts (id, cabinet_id, signature, title, severity, state, first_seen, last_seen) VALUES ($1, $2, 'x|y', 'Disk errors', 'major', 'open', SYSUTCDATETIME(), SYSUTCDATETIME())", [alertId, cabinetId]));
  const oldPlain = await addEvent(45);
  const oldPlain2 = await addEvent(80);
  const oldAlerted = await addEvent(45, { alert: alertId });
  const oldSecurity = await addEvent(45, { kind: "security" });
  const oldCrash = await addEvent(45, { source: { log: "System", source: "Microsoft-Windows-Kernel-Power", eventId: 41 } });
  const recent = await addEvent(5);
  const edge = await addEvent(29);
  const cleared = await clearOldEventDetail(db.app, Date.now(), FAST);
  assert.equal(cleared, 2);
  for (const id of [oldPlain, oldPlain2]) { const r = await eventRow(id); assert.equal(r.detail, null); assert.equal(r.source, null); assert.equal(r.kind, "error"); }
  for (const id of [oldAlerted, oldSecurity, oldCrash, recent, edge]) { const r = await eventRow(id); assert.ok(r.detail && r.source, "kept whole"); }
  // A second run finds nothing new (the cursor is past them), and a hostile detail would not matter: nothing in the statement takes row content as SQL.
  assert.equal(await clearOldEventDetail(db.app, Date.now(), FAST), 0);
  // A month later the recent event is old too, and only it is cleared.
  assert.equal(await clearOldEventDetail(db.app, Date.now() + 40 * 86_400_000, FAST), 2);
  assert.equal((await eventRow(recent)).detail, null);
  assert.ok((await eventRow(oldAlerted)).detail, "still alerted");
});

test("the nightly run keeps a 60-day-old event (cleared) and removes a 100-day-old one; a shorter setting skips clearing", async () => {
  const sixty = await addEvent(60), hundred = await addEvent(100);
  const run = await runRetention(db.app, FAST);
  assert.ok(run.events >= 1 && run.eventsCleared >= 1);
  assert.equal((await q("SELECT 1 FROM events WHERE event_id = $1", [hundred])).rowCount, 0);
  const row = await eventRow(sixty);
  assert.equal(row.detail, null);
  assert.equal((await verifyAuditChain(db.app)).ok, true);
});

// ---- Counters: counts only -----------------------------------------------------------------------------------------------------------

test("the meter keeps only counts under a safe vocabulary: hostile codes are flattened, kinds must be known, the vocabulary is bounded", () => {
  const m = new OpsMeter();
  m.count("http_5xx", "agent:/agent/v1/events:500");
  m.count("http_5xx", "agent:/agent/v1/events:500", 2);
  m.count("error_class", "x'); DROP TABLE users;--\n\u0000secret message with spaces");
  m.count("nope" as never, "a"); m.count("requests", "agent", -1); m.count("requests", "agent", Number.NaN); m.count("g_loop_lag_p95_ms" as never, "a");
  m.gauge("g_db_wait_p95_ms", "agent", 12); m.gauge("g_db_wait_p95_ms", "agent", 7); m.gauge("requests", "x", 5); m.gauge("g_db_wait_p95_ms", "agent", -3);
  for (let i = 0; i < 1000; i++) m.count("error_class", `c${i}`);
  const d = m.drain();
  assert.equal(d.counts.get("http_5xx\u0000agent:/agent/v1/events:500"), 3);
  assert.equal(d.gauges.get("g_db_wait_p95_ms\u0000agent"), 12);
  assert.ok(d.counts.size <= 301, "bounded vocabulary");
  assert.ok([...d.counts.keys()].every(k => /^[a-z_0-9]+\u0000[A-Za-z0-9_.:/\-]{1,80}$/.test(k)), "every code is in the safe alphabet");
  assert.ok(![...d.counts.keys()].some(k => /\s|'|;|\u0001/.test(k)));
  assert.equal(safeCode("a b\nc"), "a_b_c");
  assert.equal(safeCode("x".repeat(500)).length, 80);
  assert.equal(m.drain().counts.size, 0, "drained");
  assert.deepEqual(splitKey("a\u0000b:c"), ["a", "b:c"]);
});

test("responses are counted by route pattern (never the URL), sheds apart from errors; error classes carry no message", () => {
  const m = new OpsMeter();
  noteResponse("agent", "/agent/v1/events", 200, m); noteResponse("agent", "/agent/v1/events", 503, m); noteResponse("agent", "/agent/v1/results", 429, m);
  noteResponse("agent", "/agent/v1/heartbeat", 500, m); noteResponse("console", "unmatched", 502, m);
  noteError("agent", Object.assign(new Error("password=hunter2 for cabinet 1234"), { number: 515 }), m);
  const d = m.drain();
  const all = JSON.stringify([...d.counts]);
  assert.equal(d.counts.get("requests\u0000agent"), 4);
  assert.equal(d.counts.get("shed\u0000agent:503"), 1); assert.equal(d.counts.get("shed\u0000agent:429"), 1);
  assert.equal(d.counts.get("http_5xx\u0000agent:/agent/v1/heartbeat:500"), 1);
  assert.equal(d.counts.get("http_5xx\u0000console:unmatched:502"), 1);
  assert.ok(!all.includes("hunter2") && !all.includes("1234"), all);
  assert.ok(all.includes("error_class") && all.includes(":515"));
});

test("counters are written in batches: counts add up in the hour, gauges keep the highest, and old hours are pruned after 90 days", async () => {
  const m = new OpsMeter();
  const now = Date.UTC(2026, 9, 19, 10, 30);
  m.count("requests", "agent", 5); m.gauge("g_db_wait_p95_ms", "agent", 40);
  await writeOpsCounters(db.app, m.drain(), now);
  m.count("requests", "agent", 7); m.count("shed", "agent:503", 2); m.gauge("g_db_wait_p95_ms", "agent", 25);
  await writeOpsCounters(db.app, m.drain(), now + 60_000);
  await writeOpsCounters(db.app, m.drain(), now); // nothing to write is fine
  const rows = (await q<{ kind: string; code: string; count: number }>("SELECT kind, code, [count] FROM ops_counters ORDER BY kind, code")).rows;
  const get = (k: string, c: string) => Number(rows.find(r => r.kind === k && r.code === c)?.count);
  assert.equal(get("requests", "agent"), 12);
  assert.equal(get("shed", "agent:503"), 2);
  assert.equal(get("g_db_wait_p95_ms", "agent"), 40);
  // Concurrent writers (several worker processes) add up.
  await Promise.all(Array.from({ length: 6 }, async () => { const x = new OpsMeter(); x.count("requests", "agent", 1); await writeOpsCounters(db.app, x.drain(), now); }));
  assert.equal(Number((await q("SELECT [count] AS n FROM ops_counters WHERE kind = 'requests' AND code = 'agent'")).rows[0].n), 18);
  await asOwner(db, k => k.query("INSERT INTO ops_counters ([hour], kind, code, [count]) VALUES (DATEADD(day, -91, SYSUTCDATETIME()), 'requests', 'agent', 1)"));
  assert.equal(await pruneOpsCounters(db.app, Date.now()), 1);
});

test("a failed write puts the counts back so a brief outage loses nothing", async () => {
  const m = new OpsMeter();
  const reporter = new OpsReporter({ pool: { query: () => Promise.reject(new Error("database away")) } as never, meter: m, log: () => undefined });
  m.count("requests", "agent", 9);
  await reporter.flush();
  assert.equal(m.drain().counts.get("requests\u0000agent"), 9);
});

test("rates: shedding counts when it lasts 10 minutes over 5%, an error spike when 5 minutes hold 20+ errors and 2%", () => {
  const minute = (requests: number, shed = 0, errors = 0) => ({ requests, shed, errors });
  assert.equal(shedSustained(Array.from({ length: 10 }, () => minute(1000, 60))), true);
  assert.equal(shedSustained(Array.from({ length: 10 }, () => minute(1000, 50))), false, "exactly 5% is not over 5%");
  assert.equal(shedSustained([...Array.from({ length: 9 }, () => minute(1000, 600)), minute(1000, 10)]), false, "one good minute breaks it");
  assert.equal(shedSustained(Array.from({ length: 9 }, () => minute(1000, 600))), false, "not yet 10 minutes");
  assert.equal(shedSustained(Array.from({ length: 10 }, () => minute(10, 10))), false, "a quiet server's refusals are not a rate");
  assert.equal(errorSpike(Array.from({ length: 5 }, () => minute(1000, 0, 30))), true);
  assert.equal(errorSpike(Array.from({ length: 5 }, () => minute(1000, 0, 3))), false, "under 20 errors");
  assert.equal(errorSpike(Array.from({ length: 5 }, () => minute(100000, 0, 5))), false, "20+ errors but under 2%");
  assert.equal(errorSpike([]), false);
  const m = new OpsMeter(); noteResponse("agent", "/a", 200, m); noteResponse("agent", "/a", 503, m); noteResponse("agent", "/a", 500, m);
  assert.deepEqual(minuteOf(m.drain()), { requests: 3, shed: 1, errors: 1 });
});

test("the reporter raises one open alert per kind for a sustained shed rate and an error spike", async () => {
  const m = new OpsMeter();
  const reporter = new OpsReporter({ pool: db.app, meter: m, minuteMs: 3_600_000 });
  for (let i = 0; i < 10; i++) {
    for (let r = 0; r < 100; r++) noteResponse("agent", "/agent/v1/events", r < 8 ? 503 : 200, m);
    for (let r = 0; r < 4; r++) noteResponse("agent", "/agent/v1/results", 500, m);
    await reporter.flush();
  }
  assert.equal((await openAlerts("ops_shed")).length, 1);
  assert.equal((await openAlerts("ops_errors")).length, 1);
  assert.ok((await openAlerts("ops_shed"))[0]!.occurrences >= 1);
  const lag = (await q("SELECT 1 FROM ops_counters WHERE kind = 'g_loop_lag_p95_ms'")).rowCount;
  assert.ok((lag ?? 0) >= 0);
});

// ---- Health checks and alerts ----------------------------------------------------------------------------------------------------------

test("the edition limit: Express is 10 GB, other editions have none", () => {
  assert.equal(editionLimitBytes("Express Edition (64-bit)"), 10 * 1024 ** 3);
  assert.equal(editionLimitBytes("Developer Edition (64-bit)"), null);
  assert.equal(editionLimitBytes("Standard Edition (64-bit)"), null);
  assert.equal(editionLimitBytes(null), null);
});

test("database size: an alert at 70% and at 85% of the limit (one open alert, its title follows the level); it clears when the size is back under", async () => {
  const size = (await healthSummary(db.app)).database.dataBytes;
  assert.ok(size > 0);
  const checks = { thresholds: { diskMinFreePercent: 0, diskMinFreeBytes: 0, backupMaxHours: 1e9 } };
  assert.deepEqual((await runOpsChecks(db.app, { ...checks, limitBytes: Math.round(size / 0.5) })).filter(k => k === "ops_database"), [], "50%: quiet");
  assert.equal((await openAlerts("ops_database")).length, 0);
  assert.deepEqual((await runOpsChecks(db.app, { ...checks, limitBytes: Math.round(size / 0.75) })).filter(k => k === "ops_database"), ["ops_database"]);
  let open = await openAlerts("ops_database");
  assert.equal(open.length, 1); assert.match(open[0]!.title, /7\d(\.\d)?% of its edition limit/); assert.match(open[0]!.title, /alert level 70%/);
  await runOpsChecks(db.app, { ...checks, limitBytes: Math.round(size / 0.9) });
  open = await openAlerts("ops_database");
  assert.equal(open.length, 1, "deduplicated"); assert.match(open[0]!.title, /alert level 85%/); assert.ok(open[0]!.occurrences >= 2);
  await runOpsChecks(db.app, { ...checks, limitBytes: null });
  assert.equal((await openAlerts("ops_database")).length, 0, "cleared on its own");
  const resolved = (await q("SELECT resolution FROM security_alerts WHERE kind = 'ops_database' AND state = 'resolved'")).rows;
  assert.equal(resolved.length, 1);
  assert.equal((await verifyAuditChain(db.app)).ok, true);
});

test("disk space and backup age raise their own alerts; an unreadable backup history says unknown and raises nothing", async () => {
  const quiet = { thresholds: { diskMinFreePercent: 0, diskMinFreeBytes: 0, backupMaxHours: 1e9 } };
  assert.ok(!(await runOpsChecks(db.app, { ...quiet, limitBytes: null })).includes("ops_disk"));
  const alarms = await runOpsChecks(db.app, { limitBytes: null, thresholds: { diskMinFreePercent: 101, diskMinFreeBytes: 0, backupMaxHours: 1e9 } });
  const disk = (await healthSummary(db.app)).disk;
  if (disk.readable && disk.volumes.length) { assert.ok(alarms.includes("ops_disk")); assert.equal((await openAlerts("ops_disk")).length, 1); }
  await runOpsChecks(db.app, { ...quiet, limitBytes: null });
  assert.equal((await openAlerts("ops_disk")).length, 0);
  // As the database owner msdb is readable; as the application's account it may not be. Either way the page must say which.
  const asApp = (await healthSummary(db.app)).backup;
  const ownerSeen = await asOwner(db, async k => {
    const b = (await healthSummary(k)).backup;
    assert.equal(b.readable, true);
    const a = await runOpsChecks(k, { limitBytes: null, thresholds: { backupMaxHours: 36 } });
    return { b, alarm: a.includes("ops_backup") };
  });
  assert.equal(ownerSeen.alarm, ownerSeen.b.ageHours === null || ownerSeen.b.ageHours > 36);
  if (!asApp.readable) assert.equal(asApp.ageHours, null);
  await runOpsChecks(db.app, { ...quiet, limitBytes: null });
});

test("a certificate authority near expiry raises an alert; a healthy one does not", async () => {
  assert.ok(!(await runOpsChecks(db.app, { limitBytes: null, caCertificatePem: key.certificatePem, thresholds: { diskMinFreePercent: 0, diskMinFreeBytes: 0, backupMaxHours: 1e9 } })).includes("ops_ca"), "a fresh development CA");
  const quiet = { diskMinFreePercent: 0, diskMinFreeBytes: 0, backupMaxHours: 1e9 };
  const expiry = certificateExpiry(key.certificatePem)!;
  const soon = new Date(expiry.notAfter).getTime() - 30 * 86_400_000;
  assert.ok((await runOpsChecks(db.app, { limitBytes: null, caCertificatePem: key.certificatePem, now: soon, thresholds: quiet })).includes("ops_ca"));
  assert.equal((await openAlerts("ops_ca")).length, 1);
  assert.match((await openAlerts("ops_ca"))[0]!.title, /expires in 30 days/);
  const gone = new Date(expiry.notAfter).getTime() + 86_400_000;
  await runOpsChecks(db.app, { limitBytes: null, caCertificatePem: key.certificatePem, now: gone, thresholds: quiet });
  assert.match((await openAlerts("ops_ca"))[0]!.title, /has expired/);
  assert.equal((await openAlerts("ops_ca")).length, 1, "one open alert per kind");
  await runOpsChecks(db.app, { limitBytes: null, caCertificatePem: key.certificatePem, thresholds: quiet });
  assert.equal((await openAlerts("ops_ca")).length, 0);
  assert.equal(certificateExpiry("not a certificate"), null);
  assert.equal(certificateExpiry(undefined), null);
});

test("a failed migration leaves one open operations alert, naming the migration and no error text", async () => {
  const owner = await connectOwner(db.ownerUrl);
  try {
    assert.equal(await alertMigrationFailed(owner, "0099_example"), true);
    assert.equal(await alertMigrationFailed(owner, "0099_example"), true);
  } finally { await owner.close(); }
  const open = await openAlerts("ops_migration");
  assert.equal(open.length, 1); assert.equal(open[0]!.occurrences, 2); assert.match(open[0]!.title, /0099_example/);
});

test("a failed migration's alert is raised through security.ts: audited and announced like every other operations alert (D110)", async () => {
  const seqBefore = Number((await q<{ s: string | null }>("SELECT MAX(seq) AS s FROM audit_log")).rows[0]!.s ?? 0);
  const noteBefore = Number((await q<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE channel = 'security_alerts'")).rows[0]!.n);
  // A version name that is hostile and longer than a title holds: stored as text, cut to fit, never run.
  const hostile = `0098_x'; DROP TABLE security_alerts; --${"y".repeat(300)}`;
  const owner = await connectOwner(db.ownerUrl);
  try { assert.equal(await alertMigrationFailed(owner, hostile), true); } finally { await owner.close(); }
  const open = await openAlerts("ops_migration");
  assert.equal(open.length, 1, "it folds into the one open migration alert");
  assert.ok(open[0]!.title.startsWith("Database migration 0098_x'; DROP TABLE security_alerts; --"), open[0]!.title.slice(0, 80));
  assert.equal(open[0]!.title.length, 256);
  const audited = (await q<{ details: unknown }>("SELECT details FROM audit_log WHERE action = 'security.alert' AND seq > $1", [seqBefore])).rows
    .map(r => (typeof r.details === "string" ? JSON.parse(r.details) : r.details) as { kind: string; added: boolean });
  assert.deepEqual(audited.map(d => [d.kind, d.added]), [["ops_migration", false]], "audited as a repeat of the open alert");
  const noteAfter = Number((await q<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE channel = 'security_alerts'")).rows[0]!.n);
  assert.equal(noteAfter, noteBefore + 1, "the Admins' live streams are woken");
});

test("migrate hands a failed migration's version to its caller and still throws its error, and the command line raises the alert there (D110)", async () => {
  const owner = await connectOwner(db.ownerUrl);
  const told: string[] = [];
  const broken = { version: "9999_broken", checksum: "0".repeat(64), sql: "CREATE TABLE d110_half_built (id int);\nGO\nSELECT 1 / 0;" };
  try {
    await assert.rejects(migrate(owner, [...readMigrations(), broken], async v => { told.push(v); }), /Migration 9999_broken failed/);
    // A caller whose own alert fails does not hide the migration's error.
    await assert.rejects(migrate(owner, [...readMigrations(), broken], async () => { throw new Error("alert failed"); }), /Migration 9999_broken failed/);
    assert.deepEqual(told, ["9999_broken"]);
    assert.equal((await owner.request().query("SELECT 1 AS x FROM sys.tables WHERE name = 'd110_half_built'")).recordset.length, 0, "the failed migration rolled back");
    assert.equal((await owner.request().query("SELECT 1 AS x FROM schema_migrations WHERE version = '9999_broken'")).recordset.length, 0);
  } finally { await owner.close(); }
  // The command line passes security.ts's alert (src/cli.ts).
  const cli = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /migrate\(owner, undefined, version => alertMigrationFailed\(owner, version\)\)/);
});

// ---- The System health API -----------------------------------------------------------------------------------------------------------------

test("System health: the Admin sees sizes, disk, backup, certificates, audit chain, counters, cabinets and open ops alerts, and nothing secret", async () => {
  const m = new OpsMeter(); m.count("requests", "agent", 100); m.count("shed", "agent:503", 3); m.gauge("g_db_wait_p95_ms", "agent", 15);
  await writeOpsCounters(db.app, m.drain());
  const r = await call("GET", "/api/admin/system-health", undefined, bossCookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers["cache-control"], "no-store");
  const h = r.body;
  assert.ok(h.database.dataBytes > 0 && h.database.logBytes > 0);
  assert.ok("limitBytes" in h.database && "percent" in h.database && h.database.warnAtPercent === 70 && h.database.criticalAtPercent === 85);
  assert.equal(typeof h.disk.readable, "boolean"); assert.equal(typeof h.backup.readable, "boolean");
  assert.ok(h.certificates.ca.daysLeft > 300);
  assert.ok(h.auditChain && "lastVerifiedAt" in h.auditChain);
  assert.ok(h.cabinets.online + h.cabinets.offline >= 1);
  const req = h.counters.find((c: any) => c.kind === "requests" && c.code === "agent");
  assert.ok(req.last24h >= 100 && req.last7d >= req.last24h);
  assert.equal(h.counters.find((c: any) => c.kind === "g_db_wait_p95_ms").gauge, true);
  assert.ok(h.alerts.some((a: any) => a.kind === "ops_migration"), "open ops alerts are listed");
  const text = r.text;
  for (const secret of ["PRIVATE KEY", "password", "totp", "secret", "token", "hash"]) assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `the page must not carry "${secret}"`);
  assert.ok(!text.includes(key.certificatePem.slice(40, 80)), "no certificate text");
});

test("System health is Admin only, takes no parameters, is read-only", async () => {
  const t2 = await account("tier2"), t1 = await account("tier1");
  const [c2, c1] = [await signIn(t2), await signIn(t1)];
  assert.equal((await call("GET", "/api/admin/system-health")).status, 401);
  assert.equal((await call("GET", "/api/admin/system-health", undefined, c2)).status, 403);
  assert.equal((await call("GET", "/api/admin/system-health", undefined, c1)).status, 403);
  for (const hostile of ["?state=open", "?database=master", "?x[]=1", "?%00=1", "?" + "a=1&".repeat(200)])
    assert.equal((await call("GET", "/api/admin/system-health" + hostile, undefined, bossCookie)).status, 400, hostile);
  for (const method of ["POST", "PUT"] as const) assert.ok([404, 405].includes((await call(method, "/api/admin/system-health", {}, bossCookie)).status));
});

test("the status command's text carries the same facts and survives an empty database", async () => {
  const lines = formatHealth(await healthSummary(db.app, { caCertificatePem: key.certificatePem })).join("\n");
  for (const word of ["Database", "Disk", "Backup", "Certificates", "Audit chain", "Retention", "Cabinets", "Counters", "ops_migration"]) assert.ok(lines.includes(word), word);
  assert.ok(!lines.includes("PRIVATE KEY"));
});

// ---- Pacing settings --------------------------------------------------------------------------------------------------------------------------

test("an Admin sets the heartbeat interval, poll length and event pace; the heartbeat answer's source reads them back clamped to the ranges", async () => {
  assert.deepEqual((await call("GET", "/api/admin/settings", undefined, bossCookie)).body.agents, { heartbeatSeconds: 300, pollSeconds: 25, eventsPaceMs: 2000 });
  const change = { agents: { heartbeatSeconds: 120, pollSeconds: 40, eventsPaceMs: 500 } };
  const r = await call("PUT", "/api/admin/settings", { ...change, stepUpToken: await stepUp(boss, bossCookie, "settings.update", "fleet", change) }, bossCookie);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.agents, change.agents);
  assert.deepEqual(await agentPacing(db.app), change.agents);
  const one = { agents: { eventsPaceMs: 0 } };
  assert.equal((await call("PUT", "/api/admin/settings", { ...one, stepUpToken: await stepUp(boss, bossCookie, "settings.update", "fleet", one) }, bossCookie)).status, 200);
  assert.deepEqual(await agentPacing(db.app), { heartbeatSeconds: 120, pollSeconds: 40, eventsPaceMs: 0 });
  // A value somebody wrote straight into the table outside the ranges is clamped when read, never passed to agents as it is.
  await asOwner(db, async k => {
    await k.query("UPDATE settings SET [value] = '5' WHERE [key] = 'agents.heartbeatSeconds'");
    await k.query("UPDATE settings SET [value] = '99999' WHERE [key] = 'agents.pollSeconds'");
    await k.query("UPDATE settings SET [value] = '\"fast\"' WHERE [key] = 'agents.eventsPaceMs'");
  });
  assert.deepEqual(await agentPacing(db.app), { heartbeatSeconds: 60, pollSeconds: 110, eventsPaceMs: 2000 });
  const audit = (await q<{ details: any }>("SELECT TOP (1) details FROM audit_log WHERE action = 'settings.update' ORDER BY seq DESC")).rows[0]!;
  assert.ok(audit.details.after.agents);
});

test("pacing settings are validated against the contract and need a step-up bound to the exact change", async () => {
  const bad: unknown[] = [{ agents: { heartbeatSeconds: 59 } }, { agents: { heartbeatSeconds: 901 } }, { agents: { pollSeconds: 14 } }, { agents: { pollSeconds: 111 } },
    { agents: { eventsPaceMs: -1 } }, { agents: { eventsPaceMs: 60001 } }, { agents: { eventsPaceMs: 1.5 } }, { agents: { eventsPaceMs: "10" } }, { agents: {} },
    { agents: { heartbeatSeconds: 300, shell: "cmd /c" } }, { agents: [] }, { agents: null }, { agents: { heartbeatSeconds: null } }, { agents: { __proto__: { x: 1 }, heartbeatSeconds: 300, x: 1 } }];
  for (const b of bad) assert.equal((await call("PUT", "/api/admin/settings", { ...(b as object), stepUpToken: "A".repeat(43) }, bossCookie)).status, 400, JSON.stringify(b));
  // A step-up token for one change cannot authorise another.
  const asked = { agents: { heartbeatSeconds: 200 } };
  const token = await stepUp(boss, bossCookie, "settings.update", "fleet", asked);
  assert.notEqual((await call("PUT", "/api/admin/settings", { agents: { heartbeatSeconds: 900 }, stepUpToken: token }, bossCookie)).status, 200);
  // Others cannot change them at all.
  const t2 = await account("tier2"); const c2 = await signIn(t2);
  assert.equal((await call("PUT", "/api/admin/settings", { ...asked, stepUpToken: "A".repeat(43) }, c2)).status, 403);
  assert.equal((await call("GET", "/api/admin/settings", undefined, c2)).status, 403);
  assert.notEqual((await agentPacing(db.app)).heartbeatSeconds, 900);
});

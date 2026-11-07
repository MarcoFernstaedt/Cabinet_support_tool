// Milestone 10 on the server: watched-services lists per level (roles, hostile input, inheritance), service events
// turned into alerts, and service.control as a click-level write (docs/spec/12-milestones-8-to-12.md).
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
import { storeEvents } from "../src/services/events.js";
import { watchLevels } from "../src/services/watched-services.js";
import { ISSUE } from "../src/services/rules.js";
import type { Event } from "../src/contracts.js";
import { paramsHash } from "../src/auth/canonical.js";
import { storedApprovedApps } from "../src/services/approved-apps.js";
import { asOwner, createTestDatabase, type TestDatabase, startFeed } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
let cabinetId: string, siteId: string, clientId: string;

interface Account { id: string; username: string; password: string; secret: Buffer; }
async function account(role: "tier1" | "tier2" | "admin"): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
  await db.app.query<any>(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, 0, 1, $6)`,
    [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(a.secret)]);
  return a;
}
const nextCode = (a: Account) => { clock += 30_000; return totp.code(a.secret, totp.stepAt(clock)); };
async function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  let parsed: any = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}
async function signIn(a: Account): Promise<string> {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: a.username, password: a.password }) });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  assert.equal((await call("POST", "/api/auth/totp", { code: nextCode(a) }, cookie)).body.stage, "complete");
  return cookie;
}
async function stepUpToken(a: Account, cookie: string, action: string, target: string, params: unknown): Promise<string> {
  const r = await call("POST", "/api/auth/step-up", { code: nextCode(a), action, target, paramsHash: paramsHash(params) }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
const serviceEvent = (service: string, change: string, extra: Record<string, string> = {}): Event => ({
  eventId: randomUUID(), kind: "service", occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), severityHint: change === "failing" ? "major" : "minor",
  detail: { message: `${service} ${change}`, fields: { service, change, restartsToday: "1", ...extra } },
});
const alertFor = async (signature: string) => (await db.app.query<{ state: string; severity: string; title: string; occurrences: number }>(
  "SELECT TOP (1) state, severity, title, occurrences FROM alerts WHERE cabinet_id = $1 AND signature = $2 ORDER BY first_seen DESC", [cabinetId, signature])).rows[0];

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock });
  const admin = await account("admin");
  const { token } = await createBootstrapToken(db.app, admin.id);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
    hostname: "CAB-1", serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 10", agentVersion: "0.5.0" } }, "127.0.0.1");
  cabinetId = (await approveEnrollment(db.app, key, requestId, { clientName: "Acme Health", siteName: "North", cabinetName: "ICU", role: "standalone" }, admin.id)).cabinetId;
  const r = (await db.app.query<{ site_id: string; client_id: string }>("SELECT s.id AS site_id, s.client_id FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [cabinetId])).rows[0]!;
  siteId = r.site_id; clientId = r.client_id;
  await db.app.query<any>("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME(), read_only = 0");
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

test("watch lists: the most specific level wins, null inherits, an empty list watches nothing; Tier 2 sets them, the fleet default is Admin's", async () => {
  const t1 = await account("tier1"); const c1 = await signIn(t1);
  const t2 = await account("tier2"); const c2 = await signIn(t2);
  const admin = await account("admin"); const ca = await signIn(admin);
  assert.deepEqual((await watchLevels(db.app, cabinetId)).source, "none");
  assert.equal((await call("PUT", `/api/clients/${clientId}/watched-services`, { names: ["BioScanSvc"] }, c1)).status, 403, "Tier 1 only looks");
  assert.equal((await call("PUT", "/api/admin/watched-services", { names: ["Spooler"] }, c2)).status, 403, "the fleet default is Admin only");
  assert.equal((await call("PUT", "/api/admin/watched-services", { names: ["Spooler"] }, ca)).status, 200);
  assert.deepEqual((await watchLevels(db.app, cabinetId)).effective, ["Spooler"]);
  assert.equal((await call("PUT", `/api/clients/${clientId}/watched-services`, { names: ["BioScanSvc", "MSSQL$SQLEXPRESS"] }, c2)).status, 200);
  assert.deepEqual([(await watchLevels(db.app, cabinetId)).source, (await watchLevels(db.app, cabinetId)).effective], ["client", ["BioScanSvc", "MSSQL$SQLEXPRESS"]]);
  assert.equal((await call("PUT", `/api/sites/${siteId}/watched-services`, { names: [] }, c2)).status, 200);
  assert.deepEqual([(await watchLevels(db.app, cabinetId)).source, (await watchLevels(db.app, cabinetId)).effective], ["site", []], "an empty list watches nothing");
  const own = await call("PUT", `/api/cabinets/${cabinetId}/watched-services`, { names: ["BioScanSvc"] }, c2);
  assert.deepEqual([own.body.source, own.body.effective], ["cabinet", ["BioScanSvc"]]);
  await call("PUT", `/api/cabinets/${cabinetId}/watched-services`, { names: null }, c2);
  assert.equal((await watchLevels(db.app, cabinetId)).source, "site", "null gives the level above back");
  const site = await call("GET", `/api/sites/${siteId}/watched-services`, undefined, c1);
  assert.deepEqual(site.body, { own: [], client: ["BioScanSvc", "MSSQL$SQLEXPRESS"], fleet: ["Spooler"], roles: {} });
  const audited = (await db.app.query<any>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'watch.set'")).rows[0].n;
  assert.equal(audited, 5);
  await call("PUT", `/api/sites/${siteId}/watched-services`, { names: null }, c2);
});

test("hostile watch lists are refused before anything reads them", async () => {
  const t2 = await account("tier2"); const c2 = await signIn(t2);
  for (const body of [{ names: ["A; shutdown /s /t 0"] }, { names: ["..\\..\\x"] }, { names: ["A", "A"] }, { names: Array.from({ length: 17 }, (_, i) => `S${i}`) },
    { names: ["a".repeat(81)] }, { names: [" leading"] }, { names: "BioScanSvc" }, {}, { names: ["A"], extra: 1 }])
    assert.equal((await call("PUT", `/api/cabinets/${cabinetId}/watched-services`, body, c2)).status, 400, JSON.stringify(body));
  assert.equal((await call("PUT", `/api/cabinets/${randomUUID()}/watched-services`, { names: ["A"] }, c2)).status, 404);
});

test("service events: an automatic restart opens a minor alert per service, 3 failed restarts a major one that recovery resolves, a missing service a minor one", async () => {
  await storeEvents(db.app, cabinetId, { events: [serviceEvent("BioScanSvc", "restarted")] });
  assert.deepEqual(await alertFor("service:restarted:BioScanSvc"), { state: "open", severity: "minor", title: "Service restarted automatically: BioScanSvc", occurrences: 1 });
  await storeEvents(db.app, cabinetId, { events: [serviceEvent("BioScanSvc", "restarted")] });
  assert.equal((await alertFor("service:restarted:BioScanSvc"))!.occurrences, 2, "repeat offenders count up");
  await storeEvents(db.app, cabinetId, { events: [serviceEvent("BioScanSvc", "failing", { errorCode: "1053" })] });
  assert.deepEqual(await alertFor("service:failing:BioScanSvc"), { state: "open", severity: "major", title: "Service will not stay running: BioScanSvc", occurrences: 1 });
  await storeEvents(db.app, cabinetId, { events: [serviceEvent("BioScanSvc", "recovered")] });
  assert.equal((await alertFor("service:failing:BioScanSvc"))!.state, "resolved");
  await storeEvents(db.app, cabinetId, { events: [serviceEvent("NoSuchSvc", "missing")] });
  assert.deepEqual((await alertFor("service:watch:NoSuchSvc"))!.severity, "minor");
  // A name outside the contract, or an unknown change, is kept as an event and raises nothing.
  await storeEvents(db.app, cabinetId, { events: [serviceEvent("x; rm -rf", "failing"), serviceEvent("BioScanSvc", "exploded")] });
  assert.equal((await db.app.query<any>("SELECT COUNT(*) AS n FROM alerts WHERE cabinet_id = $1 AND issue_type_id IN ($2, $3, $4)",
    [cabinetId, ISSUE.serviceRestarted, ISSUE.serviceFailing, ISSUE.serviceWatch])).rows[0].n, 3);
});

test("service.control needs Tier 2, an approved service and a code; services.list and processes.list are reads for everyone", async () => {
  const t1 = await account("tier1"); const c1 = await signIn(t1);
  const t2 = await account("tier2"); const c2 = await signIn(t2);
  const send = (body: unknown, cookie: string) => call("POST", `/api/cabinets/${cabinetId}/commands`, body, cookie);
  const restart = { name: "BioScanSvc", action: "restart" };
  assert.equal((await send({ operation: "service.control", params: restart }, c1)).status, 403);
  // Not on an approved list yet: refused even with a code (an older agent would run it, so the server refuses it).
  const unlisted = await send({ operation: "service.control", params: restart, stepUpToken: await stepUpToken(t2, c2, "service.control", cabinetId, restart) }, c2);
  assert.deepEqual([unlisted.status, unlisted.body.error], [403, "control_entry_not_approved"]);
  await asOwner(db, c => c.query("UPDATE clients SET approved_apps = $2 WHERE id = $1", [clientId,
    storedApprovedApps([{ key: "app:bioscan", kind: "service", name: "BioScan", path: "C:\\Program Files\\BioScan\\BioScanSvc.exe", serviceName: "BioScanSvc" }], t2.id)]));
  // Approved: still no click-only control (a code is required), and a code for other parameters does not do.
  assert.equal((await send({ operation: "service.control", params: restart }, c2)).status, 403, "a click is not enough");
  assert.equal((await send({ operation: "service.control", params: restart, stepUpToken: await stepUpToken(t2, c2, "service.control", cabinetId, { ...restart, action: "stop" }) }, c2)).status, 403);
  assert.equal((await send({ operation: "service.control", params: restart, stepUpToken: await stepUpToken(t2, c2, "service.control", cabinetId, restart) }, c2)).status, 202);
  for (const params of [{ name: "x & net user", action: "start" }, { name: "BioScanSvc", action: "disable" }, { name: "BioScanSvc", action: "start", startType: "automatic" }])
    assert.equal((await send({ operation: "service.control", params }, c2)).status, 400, JSON.stringify(params));
  assert.equal((await send({ operation: "services.list", params: {} }, c1)).status, 202);
  assert.equal((await send({ operation: "processes.list", params: {} }, c1)).status, 202);
  assert.equal((await send({ operation: "processes.list", params: { includeCommandLines: true } }, c1)).status, 400);
  await db.app.query<any>("UPDATE commands SET status = 'expired' WHERE status = 'queued'");
});

// Milestone 5 on the server: writes from the console (role, step-up, pauses, limits, read-only),
// the software library (checks, two-person rule, retirement), downloads and firewall history.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { storeResult, takeQueuedCommands } from "../src/services/commands.js";
import { storeEvents } from "../src/services/events.js";
import { downloadablePath } from "../src/services/packages.js";
import { TrustList } from "../src/packages/trust.js";
import { ISSUE } from "../src/services/rules.js";
import { verifyAuditChain } from "../src/db/db.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";
import { pe, TestPki, zip } from "./package-pki.js";

const ORIGIN = "https://console.test";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const pki = new TestPki();
const vendor = pki.signer("Scanner Vendor Inc", "Scanner Vendor");
const trust = TrustList.fromFolder(pki.trustFolder([{ cn: "Scanner Vendor Inc", o: "Scanner Vendor", types: ["driver", "msi"] }]));
const store = { dir: tempDir(), maxBytes: 64 * 1024, trust };
let cabinetId: string, clientId: string;

interface Account { id: string; username: string; password: string; secret: Buffer; }
async function account(role: "tier1" | "tier2" | "admin"): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, false, true, $6)`,
    [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(a.secret)]);
  return a;
}
const nextCode = (a: Account) => { clock += 30_000; return totp.code(a.secret, totp.stepAt(clock)); };
interface Reply { status: number; body: any; }
async function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie?: string, raw?: Buffer): Promise<Reply> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (raw) headers["content-type"] = "application/octet-stream";
  else if (body !== undefined) headers["content-type"] = "application/json";
  const r = await app.inject({ method, url, headers, ...(raw ? { payload: raw } : body === undefined ? {} : { payload: JSON.stringify(body) }) });
  let parsed: unknown = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}
async function signIn(a: Account): Promise<string> {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: a.username, password: a.password }) });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  assert.equal((await call("POST", "/api/auth/totp", { code: nextCode(a) }, cookie)).body.stage, "complete");
  return cookie;
}
async function stepUp(a: Account, cookie: string, action: string, target: string): Promise<string> {
  const r = await call("POST", "/api/auth/step-up", { code: nextCode(a), action, target }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
const write = async (a: Account, cookie: string, operation: string, params: Record<string, unknown>, target = cabinetId) =>
  call("POST", `/api/cabinets/${target}/commands`, { operation, params, stepUpToken: await stepUp(a, cookie, operation, target) }, cookie);
const DNS = { interfaceIndex: 12, mode: "automatic" };

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, packages: store, logger: false, now: () => clock });
  const admin = await account("admin");
  const { token } = await createBootstrapToken(db.app, admin.id);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
    hostname: "CAB-1", serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 10", agentVersion: "0.5.0" } }, "127.0.0.1");
  cabinetId = (await approveEnrollment(db.app, key, requestId, { clientName: "Acme Health", siteName: "North", cabinetName: "ICU", role: "standalone" }, admin.id)).cabinetId;
  clientId = (await db.app.query<{ client_id: string }>("SELECT s.client_id FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [cabinetId])).rows[0]!.client_id;
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = now(), read_only = false");
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

test("a write needs Tier 2, a step-up token for that operation on that cabinet, and is audited as a write", async () => {
  const t1 = await account("tier1"); const c1 = await signIn(t1);
  const t2 = await account("tier2"); const c2 = await signIn(t2);
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "network.setDns", params: DNS }, c1)).status, 403);
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "network.setDns", params: DNS }, c2)).body.error, "step_up_required");
  const wrongOp = await stepUp(t2, c2, "network.setIp", cabinetId);
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "network.setDns", params: DNS, stepUpToken: wrongOp }, c2)).body.error, "step_up_required");
  const otherCabinet = await stepUp(t2, c2, "network.setDns", randomUUID());
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "network.setDns", params: DNS, stepUpToken: otherCabinet }, c2)).body.error, "step_up_required");
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "system.info", params: {}, stepUpToken: "A".repeat(43) }, c2)).status, 400, "reads take no token");

  const ok = await write(t2, c2, "network.setDns", DNS);
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  const token = await stepUp(t2, c2, "network.setDns", cabinetId);
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "network.setDns", params: DNS, stepUpToken: token }, c2)).status, 202);
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "network.setDns", params: DNS, stepUpToken: token }, c2)).body.error, "step_up_required", "a token works once");
  const audit = (await db.app.query("SELECT action, details FROM audit_log WHERE details->>'commandId' = $1", [ok.body.commandId])).rows[0];
  assert.equal(audit.action, "command.write");
  for (const params of [{ interfaceIndex: 12, mode: "static" }, { interfaceIndex: 0, mode: "automatic" }, { interfaceIndex: 12, mode: "automatic", servers: ["1.1.1.1"] }])
    assert.equal((await write(t2, c2, "network.setDns", params)).status, 400, JSON.stringify(params));
  await db.app.query("UPDATE commands SET status = 'expired' WHERE status = 'queued'");
});

test("turning a profile off with no time limit is Admin only", async () => {
  const t2 = await account("tier2"); const c2 = await signIn(t2);
  const admin = await account("admin"); const ca = await signIn(admin);
  const off = { profile: "public", enabled: false, defaultInbound: "block", defaultOutbound: "allow", noTimeLimit: true };
  assert.equal((await write(t2, c2, "firewall.setProfile", off)).status, 403);
  assert.equal((await write(admin, ca, "firewall.setProfile", off)).status, 202);
  assert.equal((await write(t2, c2, "firewall.setProfile", { ...off, noTimeLimit: undefined, durationMinutes: 60 })).status, 202);
  assert.equal((await write(t2, c2, "firewall.setProfile", { ...off, noTimeLimit: undefined, durationMinutes: 481 })).status, 400);
  assert.equal((await write(t2, c2, "firewall.setProfile", { ...off, noTimeLimit: undefined })).status, 400, "off needs a duration");
});

test("a fleet or client write pause stops writes but not reads; a read-only cabinet refuses writes", async () => {
  const admin = await account("admin"); const ca = await signIn(admin);
  const t2 = await account("tier2"); const c2 = await signIn(t2);
  const pause = await call("POST", "/api/admin/writes", { paused: true, reason: "Investigating", stepUpToken: await stepUp(admin, ca, "writes.pause", "fleet") }, ca);
  assert.equal(pause.body.fleet.paused, true);
  assert.equal((await call("GET", "/api/writes/status", undefined, c2)).body.fleet.reason, "Investigating");
  assert.equal((await write(t2, c2, "network.setDns", DNS)).body.error, "writes_paused");
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "system.info", params: {} }, c2)).status, 202, "reads keep working");
  await call("POST", "/api/admin/writes", { paused: false, stepUpToken: await stepUp(admin, ca, "writes.resume", "fleet") }, ca);

  const cp = await call("POST", `/api/admin/clients/${clientId}/writes`, { paused: true, reason: "Client asked", stepUpToken: await stepUp(admin, ca, "writes.pause", clientId) }, ca);
  assert.deepEqual(cp.body.clients.map((c: { name: string }) => c.name), ["Acme Health"]);
  assert.equal((await write(t2, c2, "network.setDns", DNS)).body.error, "writes_paused");
  await call("POST", `/api/admin/clients/${clientId}/writes`, { paused: false, stepUpToken: await stepUp(admin, ca, "writes.resume", clientId) }, ca);
  assert.equal((await call("POST", "/api/admin/writes", { paused: true, stepUpToken: await stepUp(t2, c2, "writes.pause", "fleet") }, c2)).status, 403, "Admin only");

  await db.app.query("UPDATE cabinets SET read_only = true WHERE id = $1", [cabinetId]);
  assert.equal((await write(t2, c2, "network.setDns", DNS)).body.error, "read_only_cabinet");
  await db.app.query("UPDATE cabinets SET read_only = false WHERE id = $1", [cabinetId]);
  await db.app.query("UPDATE commands SET status = 'expired' WHERE status = 'queued'");
});

test("going over the hourly write limit pauses that user's writes until an Admin resumes them", async () => {
  const t2 = await account("tier2"); const c2 = await signIn(t2);
  await db.app.query("UPDATE users SET write_limit = 2 WHERE id = $1", [t2.id]);
  assert.equal((await write(t2, c2, "network.setDns", DNS)).status, 202);
  assert.equal((await write(t2, c2, "network.setDns", DNS)).status, 202);
  assert.equal((await write(t2, c2, "network.setDns", DNS)).body.error, "write_limit_reached");
  assert.equal((await db.app.query("SELECT writes_paused FROM users WHERE id = $1", [t2.id])).rows[0].writes_paused, true);
  assert.equal((await write(t2, c2, "network.setDns", DNS)).body.error, "writes_paused_for_you");
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "system.info", params: {} }, c2)).status, 202);
  const audited = (await db.app.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'writes.user_paused' AND target_id = $1", [t2.id])).rows[0].n;
  assert.equal(audited, 1);
  await db.app.query("UPDATE commands SET status = 'expired' WHERE status = 'queued'");
});

// ---- The software library ---------------------------------------------------------------

const INF = Buffer.from("[Version]\r\nSignature=\"$WINDOWS NT$\"\r\nCatalogFile=scanner.cat\r\n");
const SYS = pe("scanner driver");
const driver = (cat = pki.catalog(vendor, [INF, SYS])) => zip([["scanner.inf", INF], ["scanner.sys", SYS], ["scanner.cat", cat]]);

async function upload(admin: Account, cookie: string, file: Buffer, version = randomUUID().slice(0, 8)) {
  const start = await call("POST", "/api/admin/packages", { name: "Scanner driver", version, vendor: "Scanner Vendor", packageType: "driver",
    hardwareIds: ["USB\\VID_1234&PID_5678"], stepUpToken: await stepUp(admin, cookie, "package.upload", "fleet") }, cookie);
  assert.equal(start.status, 201, JSON.stringify(start.body));
  return { id: start.body.packageId as string, content: await call("PUT", `/api/admin/packages/${start.body.packageId}/content`, undefined, cookie, file) };
}

test("a package is checked on upload, approved by a different Admin, stored read-only, and retiring blocks installs", async () => {
  const a1 = await account("admin"); const c1 = await signIn(a1);
  const a2 = await account("admin"); const c2 = await signIn(a2);
  const t2 = await account("tier2"); const ct = await signIn(t2);
  const { id, content } = await upload(a1, c1, driver());
  assert.equal(content.status, 200, JSON.stringify(content.body));
  assert.equal(content.body.state, "uploaded");
  assert.equal(content.body.signer, "Scanner Vendor Inc");
  const file = join(store.dir, `${content.body.sha256}.pkg`);
  assert.equal(statSync(file).mode & 0o222, 0, "stored read-only");
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), content.body.sha256);

  // Not yet approved: it cannot be installed.
  assert.equal((await write(t2, ct, "package.install", { packageId: id, packageType: "driver", sha256: "0".repeat(64) })).body.error, "package_not_approved");
  assert.equal((await call("POST", `/api/admin/packages/${id}/approve`, { stepUpToken: await stepUp(a1, c1, "package.approve", id) }, c1)).body.error, "same_person");
  const approved = await call("POST", `/api/admin/packages/${id}/approve`, { stepUpToken: await stepUp(a2, c2, "package.approve", id) }, c2);
  assert.equal(approved.body.state, "approved");
  assert.equal(approved.body.approvedBy.id, a2.id);

  // The server fills in the type and the approved hash, whatever the browser sent.
  const install = await write(t2, ct, "package.install", { packageId: id, packageType: "msi", sha256: "f".repeat(64) });
  assert.equal(install.status, 202);
  const params = (await db.app.query("SELECT params FROM commands WHERE id = $1", [install.body.commandId])).rows[0].params;
  assert.deepEqual(params, { packageId: id, packageType: "driver", sha256: content.body.sha256 });

  // The agent may download it only while that command is open for that cabinet.
  assert.equal(await downloadablePath(db.app, store, cabinetId, id), null, "not yet delivered");
  await takeQueuedCommands(db.app, cabinetId);
  assert.ok(await downloadablePath(db.app, store, cabinetId, id));
  assert.equal(await downloadablePath(db.app, store, randomUUID(), id), null, "another cabinet");
  await storeResult(db.app, cabinetId, { commandId: install.body.commandId, status: "rejected", startedAt: new Date().toISOString().replace(/\.\d+Z/, "Z"),
    finishedAt: new Date().toISOString().replace(/\.\d+Z/, "Z"), error: { code: "publisher_not_trusted", message: "x" } });
  assert.equal(await downloadablePath(db.app, store, cabinetId, id), null, "answered");

  assert.equal((await call("POST", `/api/admin/packages/${id}/retire`, { stepUpToken: await stepUp(a2, c2, "package.retire", id) }, c2)).body.state, "retired");
  assert.equal((await write(t2, ct, "package.install", { packageId: id, packageType: "driver", sha256: content.body.sha256 })).body.error, "package_not_approved");
  assert.equal((await call("GET", "/api/packages", undefined, ct)).body.some((p: { id: string }) => p.id === id), false);
  const actions = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE details->>'packageId' = $1 ORDER BY seq", [id])).rows.map(r => r.action);
  assert.deepEqual(actions.filter(a => a.startsWith("package.")), ["package.upload.start", "package.upload", "package.approve", "package.retire"]);
});

test("unsigned, tampered, unlisted and oversized uploads are refused and kept as refused", async () => {
  const a = await account("admin"); const c = await signIn(a);
  const tampered = zip([["scanner.inf", INF], ["scanner.sys", pe("evil")], ["scanner.cat", pki.catalog(vendor, [INF, SYS])]]);
  const unlisted = driver(pki.catalog(pki.signer("Evil Corp", "Evil"), [INF, SYS]));
  for (const [file, code] of [[zip([["scanner.inf", INF], ["scanner.sys", SYS]]), "signature_invalid"], [tampered, "signature_invalid"], [unlisted, "publisher_not_trusted"],
    [Buffer.from("MZ not a zip"), "verification_failed"]] as const) {
    const { id, content } = await upload(a, c, file);
    assert.equal(content.status, 422, JSON.stringify(content.body));
    assert.equal(content.body.error, code);
    const row = (await db.app.query("SELECT state, refusal FROM packages WHERE id = $1", [id])).rows[0];
    assert.equal(row.state, "refused");
    assert.match(row.refusal, new RegExp(`^${code}`));
  }
  const big = await upload(a, c, Buffer.alloc(store.maxBytes + 1));
  assert.equal(big.content.status, 413);
  const dup = await call("POST", "/api/admin/packages", { name: "Scanner driver", version: "same", vendor: "V", packageType: "driver", hardwareIds: [], stepUpToken: await stepUp(a, c, "package.upload", "fleet") }, c);
  assert.equal(dup.status, 201);
  assert.equal((await call("POST", "/api/admin/packages", { name: "Scanner driver", version: "same", vendor: "V", packageType: "driver", hardwareIds: [], stepUpToken: await stepUp(a, c, "package.upload", "fleet") }, c)).body.error, "version_exists");
  // Only the uploading Admin sends the file, and only once.
  const other = await account("admin"); const oc = await signIn(other);
  assert.equal((await call("PUT", `/api/admin/packages/${dup.body.packageId}/content`, undefined, oc, driver())).body.error, "not_uploading");
  const t2 = await account("tier2"); const ct = await signIn(t2);
  assert.equal((await call("POST", "/api/admin/packages", { name: "x", version: "1", vendor: "V", packageType: "driver", hardwareIds: [], stepUpToken: "A".repeat(43) }, ct)).status, 403);
  for (const hostile of [{ packageType: "exe" }, { arguments: "/quiet" }, { name: "<script>" }])
    assert.equal((await call("POST", "/api/admin/packages", { name: "x", version: "1", vendor: "V", packageType: "driver", hardwareIds: [], stepUpToken: "A".repeat(43), ...hostile }, c)).status, 400, JSON.stringify(hostile));
});

// ---- Firewall history -------------------------------------------------------------------

test("firewall changes through the platform are history; any other change, or a forged command ID, raises an alert", async () => {
  const t2 = await account("tier2"); const c2 = await signIn(t2);
  const cmd = await write(t2, c2, "firewall.setRule", { change: "disable", ruleName: "Remote Desktop - User Mode (TCP-In)" });
  await takeQueuedCommands(db.app, cabinetId);
  const now = new Date().toISOString().replace(/\.\d+Z/, "Z");
  const rule = { name: "Remote Desktop - User Mode (TCP-In)", direction: "in", action: "allow", enabled: true, createdByPlatform: false };
  await storeResult(db.app, cabinetId, { commandId: cmd.body.commandId, status: "succeeded", startedAt: now, finishedAt: now,
    output: { change: "disable", before: rule, after: { ...rule, enabled: false }, snapshotId: randomUUID(), safetyNetDeadline: now } });
  const ours = await storeEvents(db.app, cabinetId, { events: [{ eventId: randomUUID(), kind: "firewall_changed", occurredAt: now, severityHint: "minor", commandId: cmd.body.commandId, detail: { message: "1 changed" } }] });
  assert.deepEqual(ours.outcomes, [{ kind: "platform_change" }]);
  const forged = await storeEvents(db.app, cabinetId, { events: [{ eventId: randomUUID(), kind: "firewall_changed", occurredAt: now, severityHint: "minor", commandId: randomUUID(), detail: { message: "x" } }] });
  assert.equal((forged.outcomes[0] as { issueTypeId: string }).issueTypeId, ISSUE.firewall);
  const history = (await call("GET", `/api/cabinets/${cabinetId}/firewall-history`, undefined, c2)).body;
  assert.equal(history.length, 2);
  const platform = history.find((h: { explained: boolean }) => h.explained);
  assert.equal(platform.by, "Test " + t2.username);
  assert.equal(platform.operation, "firewall.setRule");
  assert.equal(platform.after.enabled, false);
  assert.equal(history.find((h: { explained: boolean }) => !h.explained).commandId, null);
  assert.equal((await asOwner(db, c => verifyAuditChain(c))).ok, true);
});

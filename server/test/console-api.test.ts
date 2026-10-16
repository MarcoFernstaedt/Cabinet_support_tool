import { trustProxy } from "../src/config.js";
import test from "node:test";
import { paramsHash } from "../src/auth/canonical.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { verifyAuditChain } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir, firstCookie } from "./helpers.js";

const ORIGIN = "https://console.test";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
let cabinetId: string;
let siteId: string;
let key: Awaited<ReturnType<typeof developmentIssuingKey>>;

interface Account { id: string; username: string; password: string; secret?: Buffer; }

async function account(role: "tier1" | "tier2" | "admin", opts: { totp?: boolean; mustChange?: boolean } = {}): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple" };
  const secret = (opts.totp ?? true) ? totp.newSecret() : undefined;
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [a.id, a.username, "Test " + role, role, await hashPassword(a.password), opts.mustChange ?? false, !!secret, secret ? secrets.seal(secret) : null]);
  if (secret) a.secret = secret;
  return a;
}

let step = 0;
/** A valid code for the next 30-second step, so codes are never reused by accident in tests. */
function nextCode(a: Account): string { clock += 30_000; step = totp.stepAt(clock); return totp.code(a.secret!, step); }

interface Reply { status: number; body: any; cookie?: string; headers: Record<string, unknown>; }
async function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie?: string, origin: string | null = ORIGIN): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const r = body === undefined ? await app.inject({ method, url, headers }) : await app.inject({ method, url, headers, payload: JSON.stringify(body) });
  const set = r.headers["set-cookie"];
  const c = firstCookie(set);
  let parsed: unknown = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed, ...(c ? { cookie: c } : {}), headers: r.headers };
}

/** Signs in fully and returns the session cookie. */
async function signIn(a: Account): Promise<string> {
  const r = await call("POST", "/api/auth/login", { username: a.username, password: a.password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.stage === "totp") assert.equal((await call("POST", "/api/auth/totp", { code: nextCode(a) }, r.cookie)).body.stage, "complete");
  return r.cookie!;
}

async function stepUp(a: Account, cookie: string, action: string, target: string, params?: unknown): Promise<string> {
  const r = await call("POST", "/api/auth/step-up", { code: nextCode(a), action, target, ...(params !== undefined ? { paramsHash: paramsHash(params) } : {}) }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

test.before(async () => {
  db = await createTestDatabase();
  key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  const staticDir = tempDir();
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Console</title>");
  writeFileSync(join(staticDir, "assets", "app.js"), "console.log(1)");
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, staticDir, logger: false, now: () => clock });
  // One enrolled cabinet to look at.
  const admin = await account("admin", { totp: true });
  const { token } = await createBootstrapToken(db.app, admin.id);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
    hostname: "CAB-01", serialNumber: "SN1", macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z",
    osVersion: "Windows 10", agentVersion: "0.2.0" } }, "127.0.0.1");
  cabinetId = (await approveEnrollment(db.app, key, requestId, { clientName: "Acme Health", siteName: "North", cabinetName: "ICU 1", role: "sync" }, admin.id)).cabinetId;
  siteId = (await db.app.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [cabinetId])).rows[0]!.site_id;
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

test("wrong and unknown accounts get the same answer, and five failures lock the account", async () => {
  const a = await account("tier1");
  const wrong = await call("POST", "/api/auth/login", { username: a.username, password: "nope" });
  const unknown = await call("POST", "/api/auth/login", { username: "nobody.here", password: "nope" });
  assert.deepEqual([wrong.status, wrong.body], [401, { error: "invalid_credentials" }]);
  assert.deepEqual([unknown.status, unknown.body], [401, { error: "invalid_credentials" }]);
  for (let i = 0; i < 4; i++) await call("POST", "/api/auth/login", { username: a.username, password: "nope" });
  assert.deepEqual((await call("POST", "/api/auth/login", { username: a.username, password: a.password })).body, { error: "account_locked" });
});

test("a correct password never clears wrong authenticator codes, so guessing codes locks the account", async () => {
  const a = await account("tier2", { totp: true });
  for (let round = 0; round < 3; round++) {
    const login = await call("POST", "/api/auth/login", { username: a.username, password: a.password });
    if (login.status === 429) break;
    assert.equal(login.body.stage, "totp");
    for (let i = 0; i < 2; i++) await call("POST", "/api/auth/totp", { code: "000001" }, login.cookie);
  }
  assert.deepEqual((await call("POST", "/api/auth/login", { username: a.username, password: a.password })).body, { error: "account_locked" });
  const alerts = (await db.app.query("SELECT 1 FROM security_alerts WHERE kind = 'failed_logins' AND user_id = $1", [a.id])).rows;
  assert.equal(alerts.length, 1, "the lock raised a security alert");
});

test("after a lock runs out the count starts again: one more mistake does not re-lock, five do", async () => {
  const a = await account("tier1");
  for (let i = 0; i < 5; i++) await call("POST", "/api/auth/login", { username: a.username, password: "nope" });
  await db.app.query("UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1", [a.id]);
  await call("POST", "/api/auth/login", { username: a.username, password: "nope" });
  assert.equal((await call("POST", "/api/auth/login", { username: a.username, password: a.password })).status, 200);
  for (let i = 0; i < 5; i++) await call("POST", "/api/auth/login", { username: a.username, password: "nope" });
  assert.deepEqual((await call("POST", "/api/auth/login", { username: a.username, password: a.password })).body, { error: "account_locked" });
});

test("authenticator setup shows the same secret until it is confirmed", async () => {
  const a = await account("tier2", { totp: false });
  const login = await call("POST", "/api/auth/login", { username: a.username, password: a.password });
  const first = await call("GET", "/api/auth/totp/setup", undefined, login.cookie);
  const again = await call("GET", "/api/auth/totp/setup", undefined, login.cookie);
  assert.equal(again.body.secret, first.body.secret, "a second request cannot swap the secret being set up");
});

test("a Tier 1 user signs in with a password and a code and gets an HttpOnly, Secure, SameSite=Strict cookie", async () => {
  const a = await account("tier1");
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: JSON.stringify({ username: a.username, password: a.password }),
    headers: { "content-type": "application/json", origin: ORIGIN } });
  assert.equal(JSON.parse(r.body).stage, "totp", "Tier 1 needs the code too");
  const set = String(r.headers["set-cookie"]);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(set.includes(flag), flag);
  const cookie = set.split(";")[0]!;
  assert.equal((await call("POST", "/api/auth/totp", { code: nextCode(a) }, cookie)).body.stage, "complete");
  const me = await call("GET", "/api/auth/me", undefined, cookie);
  assert.equal(me.body.user.role, "tier1");
});

test("every account, Tier 1 included, must set up the authenticator before anything else", async () => {
  const a = await account("tier1", { totp: false });
  const login = await call("POST", "/api/auth/login", { username: a.username, password: a.password });
  assert.equal(login.body.stage, "totp_setup");
  assert.equal((await call("GET", "/api/fleet/clients", undefined, login.cookie)).body.error, "sign_in_incomplete");
  const setup = await call("GET", "/api/auth/totp/setup", undefined, login.cookie);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);
  const secret = Buffer.from(setup.body.secret.split("").reduce((bits: string, ch: string) => bits + "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch).toString(2).padStart(5, "0"), "")
    .match(/.{8}/g)!.map((b: string) => parseInt(b, 2)));
  a.secret = secret;
  assert.equal((await call("POST", "/api/auth/totp/setup", { code: "000000" }, login.cookie)).status, 401);
  assert.equal((await call("POST", "/api/auth/totp/setup", { code: nextCode(a) }, login.cookie)).body.stage, "complete");
  assert.equal((await call("GET", "/api/fleet/clients", undefined, login.cookie)).status, 200);
});

test("with two-factor on, the code is required, and the same code cannot be used twice", async () => {
  const a = await account("tier2", { totp: true });
  const login = await call("POST", "/api/auth/login", { username: a.username, password: a.password });
  assert.equal(login.body.stage, "totp");
  assert.equal((await call("GET", "/api/fleet/clients", undefined, login.cookie)).status, 401);
  assert.equal((await call("POST", "/api/auth/totp", { code: "123456" }, login.cookie)).status, 401);
  const code = nextCode(a);
  assert.equal((await call("POST", "/api/auth/totp", { code }, login.cookie)).body.stage, "complete");
  const reuse = await call("POST", "/api/auth/step-up", { code, action: "cabinet.scanner", target: cabinetId }, login.cookie);
  assert.deepEqual(reuse.body, { error: "invalid_code" });
});

test("a forced password change blocks the console until done, and ends the user's other sessions", async () => {
  const a = await account("tier1", { mustChange: true });
  const other = (await call("POST", "/api/auth/login", { username: a.username, password: a.password })).cookie!;
  const login = await call("POST", "/api/auth/login", { username: a.username, password: a.password });
  assert.equal((await call("POST", "/api/auth/totp", { code: nextCode(a) }, login.cookie)).body.stage, "password_change");
  assert.equal((await call("GET", "/api/fleet/clients", undefined, login.cookie)).status, 401);
  assert.equal((await call("POST", "/api/auth/password", { currentPassword: a.password, newPassword: "short" }, login.cookie)).status, 400);
  assert.equal((await call("POST", "/api/auth/password", { currentPassword: a.password, newPassword: "a brand new long passphrase" }, login.cookie)).body.stage, "complete");
  assert.equal((await call("GET", "/api/fleet/clients", undefined, login.cookie)).status, 200);
  assert.equal((await call("GET", "/api/auth/me", undefined, other)).status, 401, "the other session ended");
});

test("state-changing requests without the console's Origin are refused", async () => {
  const a = await account("tier1");
  const cookie = await signIn(a);
  for (const origin of [null, "https://evil.example"]) {
    const r = await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "system.info", params: {} }, cookie, origin);
    assert.deepEqual([r.status, r.body], [403, { error: "origin_refused" }]);
  }
  assert.equal((await call("POST", "/api/auth/login", { username: a.username, password: a.password }, undefined, null)).status, 403);
});

test("every route checks the role on the server", async () => {
  const users = { tier1: await account("tier1"), tier2: await account("tier2", { totp: true }), admin: await account("admin", { totp: true }) };
  const cookies = { tier1: await signIn(users.tier1), tier2: await signIn(users.tier2), admin: await signIn(users.admin) };
  const token = "A".repeat(43);
  const routes: [string, "GET" | "POST" | "PUT", string, unknown, "tier1" | "tier2" | "admin"][] = [
    ["clients", "GET", "/api/fleet/clients", undefined, "tier1"],
    ["cabinet", "GET", `/api/fleet/cabinets/${cabinetId}`, undefined, "tier1"],
    ["site", "GET", `/api/fleet/sites/${siteId}`, undefined, "tier1"],
    ["search", "GET", "/api/fleet/search?q=ICU", undefined, "tier1"],
    ["history", "GET", `/api/cabinets/${cabinetId}/commands`, undefined, "tier1"],
    ["fleet scanner read", "GET", "/api/settings/scanner", undefined, "tier1"],
    ["cabinet scanner", "PUT", `/api/cabinets/${cabinetId}/scanner`, { hardwareIds: null, stepUpToken: token }, "tier2"],
    ["fleet scanner", "PUT", "/api/settings/scanner", { hardwareIds: null, stepUpToken: token }, "admin"],
    ["site sync", "PUT", `/api/sites/${siteId}/sync`, { address: null, ports: [], stepUpToken: token }, "admin"],
    ["pending", "GET", "/api/admin/enrollments", undefined, "admin"],
    ["approve", "POST", `/api/admin/enrollments/${randomUUID()}/approve`, { client: "a", site: "b", cabinet: "c", role: "sync", stepUpToken: token }, "admin"],
    ["tokens", "POST", "/api/admin/bootstrap-tokens", { stepUpToken: token }, "admin"],
    ["revoke", "POST", `/api/admin/cabinets/${cabinetId}/revoke`, { stepUpToken: token }, "admin"],
    ["audit", "GET", "/api/admin/audit", undefined, "admin"],
  ];
  const rank = { tier1: 1, tier2: 2, admin: 3 } as const;
  for (const [label, method, url, body, minimum] of routes) {
    assert.equal((await call(method, url, body)).status, 401, `${label}: signed out`);
    for (const role of ["tier1", "tier2", "admin"] as const) {
      const r = await call(method, url, body, cookies[role]);
      if (rank[role] < rank[minimum]) assert.equal(r.status, 403, `${label}: ${role} must be refused`);
      else assert.ok(r.status !== 401 && !(r.status === 403 && r.body.error === "forbidden"), `${label}: ${role} is allowed past the role check (got ${r.status} ${JSON.stringify(r.body)})`);
    }
  }
});

test("a step-up token works once, only for its own action and target", async () => {
  const admin = await account("admin", { totp: true });
  const cookie = await signIn(admin);
  const token = await stepUp(admin, cookie, "site.sync", siteId, { address: "10.20.0.15", ports: [1433] });
  const granted = (await db.app.query("SELECT details FROM audit_log WHERE actor_id = $1 AND action = 'auth.step_up' AND outcome = 'succeeded'", [admin.id])).rows;
  assert.deepEqual(granted.map(r => r.details), [{ action: "site.sync", target: siteId, paramsHash: paramsHash({ address: "10.20.0.15", ports: [1433] }) }], "a granted step-up is audited");
  assert.deepEqual((await call("POST", `/api/admin/cabinets/${cabinetId}/revoke`, { stepUpToken: token }, cookie)).body, { error: "step_up_required" }, "wrong action");
  const otherSite = randomUUID();
  assert.equal((await call("PUT", `/api/sites/${otherSite}/sync`, { address: null, ports: [], stepUpToken: token }, cookie)).status, 403, "wrong target");
  assert.equal((await call("PUT", `/api/sites/${siteId}/sync`, { address: "10.20.0.99", ports: [1433], stepUpToken: token }, cookie)).status, 403, "other parameters than the ones confirmed");
  assert.equal((await call("PUT", `/api/sites/${siteId}/sync`, { address: "10.20.0.15", ports: [1433], stepUpToken: token }, cookie)).status, 200);
  assert.equal((await call("PUT", `/api/sites/${siteId}/sync`, { address: "10.20.0.16", ports: [1433], stepUpToken: token }, cookie)).status, 403, "used once");
  const expired = await stepUp(admin, cookie, "site.sync", siteId, { address: null, ports: [] });
  await db.app.query("UPDATE step_up_tokens SET expires_at = now() - interval '1 second'");
  assert.equal((await call("PUT", `/api/sites/${siteId}/sync`, { address: null, ports: [], stepUpToken: expired }, cookie)).status, 403, "expired");
});

test("the server refuses a public sync address, and fills the sync target and scanner IDs itself", async () => {
  const admin = await account("admin", { totp: true });
  const cookie = await signIn(admin);
  const bad = await call("PUT", `/api/sites/${siteId}/sync`, { address: "8.8.8.8", ports: [], stepUpToken: await stepUp(admin, cookie, "site.sync", siteId, { address: "8.8.8.8", ports: [] }) }, cookie);
  assert.deepEqual(bad.body, { error: "invalid_address" });
  await call("PUT", `/api/sites/${siteId}/sync`, { address: "10.20.0.15", ports: [1433], stepUpToken: await stepUp(admin, cookie, "site.sync", siteId, { address: "10.20.0.15", ports: [1433] }) }, cookie);
  await call("PUT", "/api/settings/scanner", { hardwareIds: ["USB\\VID_AAAA&PID_0001"], stepUpToken: await stepUp(admin, cookie, "settings.scanner", "fleet", { hardwareIds: ["USB\\VID_AAAA&PID_0001"] }) }, cookie);

  const sync = await call("POST", `/api/cabinets/${cabinetId}/commands`,
    { operation: "network.test", params: { target: "sync_cabinet", method: "tcp", port: 1433, syncAddress: "10.99.99.99" } }, cookie);
  assert.equal(sync.status, 202);
  const syncParams = (await db.app.query("SELECT params FROM commands WHERE id = $1", [sync.body.commandId])).rows[0].params;
  assert.deepEqual(syncParams, { target: "sync_cabinet", method: "tcp", port: 1433, syncAddress: "10.20.0.15", syncPorts: [1433] }, "the browser's address is replaced by the site's");

  const scan = await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "peripheral.status", params: {} }, cookie);
  assert.deepEqual((await db.app.query("SELECT params FROM commands WHERE id = $1", [scan.body.commandId])).rows[0].params, { hardwareIds: ["USB\\VID_AAAA&PID_0001"] });
  await call("PUT", `/api/cabinets/${cabinetId}/scanner`, { hardwareIds: ["USB\\VID_BBBB&PID_0002"], stepUpToken: await stepUp(admin, cookie, "cabinet.scanner", cabinetId, { hardwareIds: ["USB\\VID_BBBB&PID_0002"] }) }, cookie);
  const scan2 = await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "peripheral.status", params: {} }, cookie);
  assert.deepEqual((await db.app.query("SELECT params FROM commands WHERE id = $1", [scan2.body.commandId])).rows[0].params, { hardwareIds: ["USB\\VID_BBBB&PID_0002"] }, "the cabinet's override wins");
  const detail = await call("GET", `/api/fleet/cabinets/${cabinetId}`, undefined, cookie);
  assert.deepEqual(detail.body.scanner.effective, ["USB\\VID_BBBB&PID_0002"]);
});

test("Tier 1 runs reads but not writes, and opening a cabinet and an event entry are audited", async () => {
  const a = await account("tier1");
  const cookie = await signIn(a);
  assert.equal((await call("GET", `/api/fleet/cabinets/${cabinetId}`, undefined, cookie)).status, 200);
  const get = await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "eventlog.get", params: { log: "System", recordId: 42 } }, cookie);
  assert.equal(get.status, 202);
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "network.setDns", params: { interfaceIndex: 1, mode: "automatic" } }, cookie)).status, 403);
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "eventlog.query", params: { log: "Security" } }, cookie)).status, 400);
  const actions = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE actor_id = $1 ORDER BY seq", [a.id])).rows.map(r => r.action);
  assert.ok(actions.includes("cabinet.view"));
  assert.ok(actions.includes("eventlog.entry.open"));
  assert.equal((await verifyAuditChain(db.app)).ok, true);
});

test("search treats wildcards literally", async () => {
  const cookie = await signIn(await account("tier1"));
  assert.ok((await call("GET", "/api/fleet/search?q=ICU", undefined, cookie)).body.some((r: { name: string }) => r.name === "ICU 1"));
  assert.deepEqual((await call("GET", "/api/fleet/search?q=%25", undefined, cookie)).body, []);
  for (const hostile of ["", "?q=", "?q=a%0Ab", `?q=${"x".repeat(65)}`, "?q=a&limit=9"])
    assert.equal((await call("GET", `/api/fleet/search${hostile}`, undefined, cookie)).status, 400, hostile);
});

test("the built console is served with strict headers, and paths cannot escape its folder", async () => {
  const index = await call("GET", "/cabinets/anything");
  assert.equal(index.status, 200);
  assert.match(String(index.body), /<title>Console<\/title>/);
  assert.match(String(index.headers["content-security-policy"]), /default-src 'self'/);
  assert.equal(index.headers["x-frame-options"], "DENY");
  assert.equal((await call("GET", "/assets/app.js")).body, "console.log(1)");
  for (const path of ["/../package.json", "/assets/../../package.json", "/%2e%2e/%2e%2e/package.json"])
    assert.match(String((await call("GET", path)).body), /<title>Console<\/title>/, path);
  assert.equal((await call("GET", "/%E0%A4%A")).status, 400, "a malformed escape is refused");
  assert.equal((await call("GET", "/api/nope")).status, 404);
});

test("signing out ends the session", async () => {
  const cookie = await signIn(await account("tier1"));
  assert.equal((await call("POST", "/api/auth/logout", {}, cookie)).status, 200);
  assert.equal((await call("GET", "/api/auth/me", undefined, cookie)).status, 401);
});

test("live streams that end at once, or are cut off, leave no subscriber or timer behind", async () => {
  const { request } = await import("node:http");
  const cookie = await signIn(await account("tier1"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const open = (): Promise<() => void> => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/stream", headers: { cookie } }, res => resolve(() => { res.destroy(); req.destroy(); }));
    req.on("error", reject);
    req.end();
  });
  // Some clients wait for the stream to open and then drop it; others give up before the server even attaches.
  const opened = await Promise.all(Array.from({ length: 10 }, open));
  assert.equal(stream.count, 10);
  for (const drop of opened) drop();
  for (let i = 0; i < 10; i++) {
    const req = request({ host: "127.0.0.1", port, path: "/api/stream", headers: { cookie } });
    req.on("error", () => undefined);
    req.end(() => req.destroy());
  }
  for (let i = 0; i < 50 && stream.count > 0; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(stream.count, 0);
});

test("the proxy setting trusts a number of hops or named proxies, never any address the client writes", () => {
  assert.equal(trustProxy(undefined), false);
  assert.equal(trustProxy("1"), 1);
  assert.equal(trustProxy("10.0.0.5, 10.0.1.0/24"), "10.0.0.5, 10.0.1.0/24");
  for (const bad of ["true", "0", "9", "all", "10.0.0.5; rm", "*"]) assert.throws(() => trustProxy(bad), bad);
});

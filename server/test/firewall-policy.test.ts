// Milestone 9 on the server: confirmation levels' parameter binding, the client firewall policy, drift alerts from
// heartbeats, the one-click apply and the password-confirmed bulk apply (docs/spec/12-milestones-8-to-12.md).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { canonicalJson, paramsHash } from "../src/auth/canonical.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { evaluateDrift } from "../src/services/firewall-policy.js";
import { ISSUE } from "../src/services/rules.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
let key: Awaited<ReturnType<typeof developmentIssuingKey>>;
let boss: Account; let bossCookie: string;

interface Account { id: string; username: string; password: string; secret: Buffer; }
async function account(role: "tier1" | "tier2" | "admin"): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, false, true, $6)`,
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
async function stepUp(a: Account, cookie: string, action: string, target: string): Promise<string> {
  const r = await call("POST", "/api/auth/step-up", { code: nextCode(a), action, target }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

/** One client with two sites; returns ids. */
async function client(name: string, cabinetsPerSite = 2) {
  const ids: { client: string; sites: string[]; cabinets: string[] } = { client: "", sites: [], cabinets: [] };
  for (const site of ["North", "South"]) for (let i = 0; i < cabinetsPerSite; i++) {
    const { token } = await createBootstrapToken(db.app, boss.id);
    const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
      hostname: `${name}-${site}-${i}`, serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z",
      osVersion: "Windows 10", agentVersion: "0.5.0" } }, "127.0.0.1");
    const { cabinetId } = await approveEnrollment(db.app, key, requestId, { clientName: name, siteName: site, cabinetName: `${site} ${i}`, role: "standalone" }, boss.id);
    ids.cabinets.push(cabinetId);
  }
  const r = (await db.app.query<{ client_id: string; site_id: string }>("SELECT s.client_id, s.id AS site_id FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = ANY($1) ORDER BY s.name", [ids.cabinets])).rows;
  ids.client = r[0]!.client_id;
  ids.sites = [...new Set(r.map(x => x.site_id))];
  return ids;
}
const heartbeat = (cabinetId: string, fw: { domain: boolean; private: boolean; public: boolean } | undefined, readOnly = false) =>
  recordHeartbeat(db.app, cabinetId, { agentVersion: "0.5.0", uptimeSeconds: 100, readOnlyMode: readOnly, ...(fw ? { firewallProfiles: fw } : {}) });
const ALL_ON = { domain: true, private: true, public: true };
const ALL_OFF = { domain: false, private: false, public: false };
const driftAlert = async (cabinetId: string) => (await db.app.query<{ state: string; severity: string }>(
  "SELECT state, severity FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 ORDER BY first_seen DESC LIMIT 1", [cabinetId, ISSUE.firewallPolicy])).rows[0];

test.before(async () => {
  db = await createTestDatabase();
  key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock });
  boss = await account("admin");
  bossCookie = await signIn(boss);
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

test("canonical JSON sorts keys at every level, so the console and server hash the same parameters the same way", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  assert.equal(paramsHash({ b: 2, a: 1 }), paramsHash({ a: 1, b: 2 }));
  assert.equal(paramsHash({ a: 1 }), createHash("sha256").update('{"a":1}').digest("hex"));
  for (const bad of [Number.NaN, Infinity, () => 1, 10n]) assert.throws(() => canonicalJson(bad as unknown), String(bad));
});

test("a cabinet that differs from the fleet default (all off) gets a minor alert that closes once it matches; read-only cabinets are compared too", async () => {
  const c = await client("Policy One", 1);
  const [a, b] = c.cabinets as [string, string];
  assert.equal((await heartbeat(a, ALL_ON)).firewallChanged, true);
  await evaluateDrift(db.app, { cabinetId: a });
  assert.deepEqual(await driftAlert(a), { state: "open", severity: "minor" });
  assert.equal((await heartbeat(a, ALL_ON)).firewallChanged, false, "only a change is compared again");
  await heartbeat(a, ALL_OFF);
  await evaluateDrift(db.app, { cabinetId: a });
  assert.equal((await driftAlert(a))!.state, "resolved");
  await heartbeat(b, { ...ALL_OFF, public: true }, true);
  await evaluateDrift(db.app, { cabinetId: b });
  assert.equal((await driftAlert(b))!.state, "open", "read-only cabinets are compared, never changed");
  assert.equal((await heartbeat(b, undefined)).firewallChanged, false, "an agent that reports nothing changes nothing");
});

test("an Admin sets a client's own policy with a code; its cabinets are compared again at once, and the cabinet page shows where the policy comes from", async () => {
  const c = await client("Policy Two", 1);
  const [a] = c.cabinets as [string];
  await heartbeat(a, ALL_ON);
  await evaluateDrift(db.app, { cabinetId: a });
  assert.equal((await driftAlert(a))!.state, "open");
  const t2 = await account("tier2"); const c2 = await signIn(t2);
  const on = { domain: "on", private: "on", public: "on" };
  assert.equal((await call("PUT", `/api/clients/${c.client}/firewall-policy`, { policy: on, stepUpToken: "A".repeat(43) }, c2)).status, 403, "Admin only");
  assert.equal((await call("PUT", `/api/clients/${c.client}/firewall-policy`, { policy: { domain: true, private: true, public: true }, stepUpToken: "A".repeat(43) }, bossCookie)).status, 400);
  const r = await call("PUT", `/api/clients/${c.client}/firewall-policy`, { policy: on, stepUpToken: await stepUp(boss, bossCookie, "client.firewall_policy", c.client) }, bossCookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await driftAlert(a))!.state, "resolved", "the cabinet now matches its client's policy");
  const page = await call("GET", `/api/cabinets/${a}/firewall-policy`, undefined, c2);
  assert.deepEqual([page.body.source, page.body.differs, page.body.policy], ["client", false, on]);
  // Removing the client's policy brings back the fleet default, and the drift.
  await call("PUT", `/api/clients/${c.client}/firewall-policy`, { policy: null, stepUpToken: await stepUp(boss, bossCookie, "client.firewall_policy", c.client) }, bossCookie);
  assert.equal((await driftAlert(a))!.state, "open");
});

test("applying the policy to one cabinet is a click for Tier 1; the server fills in the profiles and refuses any the browser sends", async () => {
  const c = await client("Policy Three", 1);
  const [a] = c.cabinets as [string];
  await heartbeat(a, ALL_ON);
  const t1 = await account("tier1"); const c1 = await signIn(t1);
  const sent = await call("POST", `/api/cabinets/${a}/commands`, { operation: "firewall.applyPolicy", params: { profiles: ALL_ON } }, c1);
  assert.deepEqual([sent.status, sent.body.error], [400, "invalid_params"], "the browser cannot choose the profiles");
  const ok = await call("POST", `/api/cabinets/${a}/commands`, { operation: "firewall.applyPolicy", params: {} }, c1);
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  const cmd = (await db.app.query("SELECT params FROM commands WHERE id = $1", [ok.body.commandId])).rows[0];
  assert.deepEqual(cmd.params, { profiles: ALL_OFF });
  await db.app.query("UPDATE commands SET status = 'expired' WHERE status = 'queued'");
});

test("bulk apply: a preview, then the password bound to that site and those parameters; only online, writable cabinets that differ; counts as one write", async () => {
  const c = await client("Policy Four", 3);
  const [north0, north1, north2, south0] = c.cabinets as [string, string, string, string];
  for (const k of c.cabinets) await db.app.query("UPDATE cabinets SET last_heartbeat_at = now(), read_only = false WHERE id = $1", [k]);
  await heartbeat(north0, ALL_ON); await heartbeat(north1, ALL_OFF); await heartbeat(north2, ALL_ON); await heartbeat(south0, ALL_ON);
  await db.app.query("UPDATE cabinets SET read_only = true WHERE id = $1", [north2]);
  const north = (await db.app.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [north0])).rows[0]!.site_id;
  const t1 = await account("tier1"); const c1 = await signIn(t1);
  await db.app.query("UPDATE users SET write_limit = 1 WHERE id = $1", [t1.id]);

  const preview = await call("GET", `/api/bulk/firewall-policy?scope=site&id=${north}`, undefined, c1);
  assert.deepEqual(preview.body.cabinets.map((x: { id: string }) => x.id), [north0], "only the online, writable cabinet that differs");
  assert.equal((await call("GET", `/api/bulk/firewall-policy?scope=fleet&id=${north}`, undefined, c1)).status, 400);

  const confirm = (password: string, params: unknown, target = north) => call("POST", "/api/auth/confirm-password",
    { password, action: "bulk.firewall_policy", target, paramsHash: paramsHash(params) }, c1);
  assert.equal((await confirm("wrong password", { scope: "site", id: north })).status, 401);
  assert.equal((await db.app.query("SELECT failed_logins FROM users WHERE id = $1", [t1.id])).rows[0].failed_logins, 1, "a wrong password counts toward the lock");
  const forClient = (await confirm(t1.password, { scope: "client", id: c.client }, c.client)).body.token;
  assert.equal((await call("POST", "/api/bulk/firewall-policy", { scope: "site", id: north, stepUpToken: forClient }, c1)).status, 403, "a token for the client is not one for the site");
  const token = (await confirm(t1.password, { scope: "site", id: north })).body.token;
  const r = await call("POST", "/api/bulk/firewall-policy", { scope: "site", id: north, stepUpToken: token }, c1);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual(r.body.commands.map((x: { cabinetId: string }) => x.cabinetId), [north0]);
  assert.equal((await call("POST", "/api/bulk/firewall-policy", { scope: "site", id: north, stepUpToken: token }, c1)).status, 403, "a token works once");
  const audit = (await db.app.query("SELECT details FROM audit_log WHERE action = 'bulk.firewall_policy' AND target_id = $1", [north])).rows[0];
  assert.equal(audit.details.cabinets, 1);
  // The bulk counted as one write: with a limit of 1, the next write goes over it.
  const next = await call("POST", `/api/cabinets/${south0}/commands`, { operation: "firewall.applyPolicy", params: {} }, c1);
  assert.equal(next.body.error, "write_limit_reached");
});

test("bulk apply refuses a fleet-wide write pause, and hostile bodies before anything reads them", async () => {
  const c = await client("Policy Five", 1);
  const t1 = await account("tier1"); const c1 = await signIn(t1);
  for (const body of [{}, { scope: "site", id: "../../x", stepUpToken: "A".repeat(43) }, { scope: "site", id: c.sites[0], stepUpToken: "x" },
    { scope: "site", id: c.sites[0], stepUpToken: "A".repeat(43), profiles: ALL_ON }])
    assert.equal((await call("POST", "/api/bulk/firewall-policy", body, c1)).status, 400, JSON.stringify(body));
  for (const body of [{ password: "x", action: "user.delete", target: c.client, paramsHash: "a".repeat(64) }, { password: "x".repeat(300), action: "bulk.firewall_policy", target: c.client, paramsHash: "a".repeat(64) }])
    assert.equal((await call("POST", "/api/auth/confirm-password", body, c1)).status, 400);
  await call("POST", "/api/admin/writes", { paused: true, reason: "Incident", stepUpToken: await stepUp(boss, bossCookie, "writes.pause", "fleet") }, bossCookie);
  const token = (await call("POST", "/api/auth/confirm-password", { password: t1.password, action: "bulk.firewall_policy", target: c.client,
    paramsHash: paramsHash({ scope: "client", id: c.client }) }, c1)).body.token;
  assert.equal((await call("POST", "/api/bulk/firewall-policy", { scope: "client", id: c.client, stepUpToken: token }, c1)).body.error, "writes_paused");
  await call("POST", "/api/admin/writes", { paused: false, stepUpToken: await stepUp(boss, bossCookie, "writes.resume", "fleet") }, bossCookie);
});

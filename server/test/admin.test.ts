// Milestone 6 through the console API: account management and its rules, sessions and presence,
// activity and the audit search, clients and sites, issue types and suppressions, settings and
// retention, and a security alert for every trigger in docs/spec/05-server-spec.md.
import { paramsHash } from "../src/auth/canonical.js";
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
import { issueCommand, storeResult, takeQueuedCommands } from "../src/services/commands.js";
import { expireRules } from "../src/services/rules.js";
import { runRetention } from "../src/services/maintenance.js";
import { networkOf } from "../src/services/security.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import * as users from "../src/services/users.js";
import { verifyAuditChain, NULL_BINARY } from "../src/db/db.js";
import { asOwner, createTestDatabase, type TestDatabase, startFeed } from "./database.js";
import { csrFor, ecKey, tempDir, firstCookie } from "./helpers.js";

const ORIGIN = "https://console.test";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
let cabinetId: string;
let clientId: string;
let siteId: string;
let boss: Account;
let bossCookie: string;

interface Account { id: string; username: string; password: string; secret?: Buffer; }

async function account(role: "tier1" | "tier2" | "admin", opts: { totp?: boolean } = { totp: true }): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple" };
  const secret = opts.totp ? totp.newSecret() : undefined;
  await db.app.query<any>(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 1)`,
    [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), !!secret, secret ? secrets.seal(secret) : NULL_BINARY]);
  if (secret) a.secret = secret;
  return a;
}
const nextCode = (a: Account): string => { clock += 30_000; return totp.code(a.secret!, totp.stepAt(clock)); };

interface Reply { status: number; body: any; cookie?: string; headers: Record<string, unknown>; }
async function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie?: string, extra: { address?: string; background?: boolean } = {}): Promise<Reply> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (extra.background) headers["x-background"] = "1";
  const r = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}), remoteAddress: extra.address ?? "10.9.8.7" });
  const set = r.headers["set-cookie"];
  const c = firstCookie(set);
  let parsed: unknown = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed, ...(c ? { cookie: c } : {}), headers: r.headers };
}
async function signIn(a: Account, address?: string): Promise<string> {
  const r = await call("POST", "/api/auth/login", { username: a.username, password: a.password }, undefined, { ...(address ? { address } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.stage === "totp") assert.equal((await call("POST", "/api/auth/totp", { code: nextCode(a) }, r.cookie)).body.stage, "complete");
  return r.cookie!;
}
async function stepUp(a: Account, cookie: string, action: string, target: string, params?: unknown): Promise<string> {
  const r = await call("POST", "/api/auth/step-up", { code: nextCode(a), action, target, ...(params !== undefined ? { paramsHash: paramsHash(params) } : {}) }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
const securityAlerts = async (kind: string) =>
  (await db.app.query<{ title: string; occurrences: number; user_id: string | null; cabinet_id: string | null; detail: any }>(
    "SELECT title, occurrences, user_id, cabinet_id, detail FROM security_alerts WHERE kind = $1 AND state = 'open'", [kind])).rows;

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
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
  const k = (await db.app.query<{ site_id: string; client_id: string }>("SELECT k.site_id, s.client_id FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [cabinetId])).rows[0]!;
  siteId = k.site_id; clientId = k.client_id;
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

// ---- Accounts -------------------------------------------------------------------------------

test("an Admin creates an account with a one-time password; the new person must change it, and Tier 2 must set up an authenticator first", async () => {
  const r = await call("POST", "/api/admin/users", { username: "tess.new", name: "Tess New", role: "tier2", stepUpToken: await stepUp(boss, bossCookie, "user.create", "fleet", { username: "tess.new", name: "Tess New", role: "tier2" }) }, bossCookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.headers["cache-control"], "no-store");
  const login = await call("POST", "/api/auth/login", { username: "tess.new", password: r.body.temporaryPassword });
  assert.equal(login.body.stage, "totp_setup");
  assert.ok(!JSON.stringify((await db.app.query<any>("SELECT details FROM audit_log WHERE action = 'user.create'")).rows).includes(r.body.temporaryPassword), "the password is never audited");
  // The same username twice, and a hostile one, are refused.
  assert.equal((await call("POST", "/api/admin/users", { username: "tess.new", name: "Again", role: "tier1", stepUpToken: await stepUp(boss, bossCookie, "user.create", "fleet", { username: "tess.new", name: "Again", role: "tier1" }) }, bossCookie)).body.error, "username_taken");
  assert.equal((await call("POST", "/api/admin/users", { username: "Robert'); DROP TABLE users;--", name: "x", role: "tier1", stepUpToken: "A".repeat(43) }, bossCookie)).status, 400);
});

test("role changes need an authenticator and end the person's sessions; nobody changes their own role or disables themselves", async () => {
  const t1 = await account("tier1", { totp: false });
  const t1Cookie = await signIn(t1);
  let r = await call("PUT", `/api/admin/users/${t1.id}`, { role: "tier2", stepUpToken: await stepUp(boss, bossCookie, "user.update", t1.id, { role: "tier2" }) }, bossCookie);
  assert.equal(r.body.error, "totp_required");
  r = await call("PUT", `/api/admin/users/${t1.id}`, { writeLimit: 5, stepUpToken: await stepUp(boss, bossCookie, "user.update", t1.id, { writeLimit: 5 }) }, bossCookie);
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/api/auth/me", undefined, t1Cookie)).status, 200, "a write limit change leaves sessions alone");

  const t2 = await account("tier2");
  const t2Cookie = await signIn(t2);
  r = await call("PUT", `/api/admin/users/${t2.id}`, { role: "admin", stepUpToken: await stepUp(boss, bossCookie, "user.update", t2.id, { role: "admin" }) }, bossCookie);
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/api/auth/me", undefined, t2Cookie)).status, 401, "a new role ends their sessions");
  for (const change of [{ status: "disabled" }, { role: "tier2" }])
    assert.equal((await call("PUT", `/api/admin/users/${boss.id}`, { ...change, stepUpToken: await stepUp(boss, bossCookie, "user.update", boss.id, { ...change }) }, bossCookie)).body.error, "not_yourself");
  assert.equal((await call("POST", `/api/admin/users/${boss.id}/delete`, { stepUpToken: await stepUp(boss, bossCookie, "user.delete", boss.id) }, bossCookie)).body.error, "not_yourself");
});

test("two Admins demoting each other at the same moment leave one Admin: the last active Admin can never be removed", async () => {
  const other = await account("admin");
  const otherCookie = await signIn(other);
  await db.app.query<any>("UPDATE users SET status = 'disabled' WHERE role = 'admin' AND status = 'active' AND id NOT IN ($1, $2)", [boss.id, other.id]);
  const demote = await stepUp(boss, bossCookie, "user.update", other.id, { role: "tier2" });
  const remove = await stepUp(other, otherCookie, "user.delete", boss.id);
  const [a, b] = await Promise.all([
    call("PUT", `/api/admin/users/${other.id}`, { role: "tier2", stepUpToken: demote }, bossCookie),
    call("POST", `/api/admin/users/${boss.id}/delete`, { stepUpToken: remove }, otherCookie),
  ]);
  // The loser is refused, either by the rule or because the winner's change already ended their session.
  const outcomes = [a.status === 200 ? "ok" : a.body.error, b.status === 200 ? "ok" : b.body.error];
  assert.equal(outcomes.filter(o => o === "ok").length, 1, JSON.stringify(outcomes));
  assert.ok(outcomes.every(o => ["ok", "last_admin", "signed_out"].includes(o)), JSON.stringify(outcomes));
  let admins = (await db.app.query<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND status = 'active'")).rows;
  assert.equal(admins.length, 1);
  if (admins[0]!.id === other.id) { boss = other; bossCookie = otherCookie; }

  // The same race straight against the service, where no session can end first: the lock makes one of them see the rule.
  const third = await account("admin");
  const race = await Promise.allSettled([
    users.updateUser(db.app, boss.id, third.id, { role: "tier2" }, await issueStepUpToken(db.app, boss.id, "user.update", third.id)),
    users.updateUser(db.app, third.id, boss.id, { status: "disabled" }, await issueStepUpToken(db.app, third.id, "user.update", boss.id)),
  ]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((race.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code, "last_admin");
  admins = (await db.app.query<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND status = 'active'")).rows;
  assert.equal(admins.length, 1);
  if (admins[0]!.id === third.id) { boss = third; bossCookie = await signIn(third); }
});

test("resetting a password or an authenticator, disabling or deleting an account ends every one of that person's sessions", async () => {
  for (const [path, action] of [["reset-password", "user.password.reset"], ["reset-authenticator", "user.totp.reset"], ["delete", "user.delete"]] as const) {
    const t = await account("tier2");
    const one = await signIn(t);
    const two = await signIn(t);
    const r = await call("POST", `/api/admin/users/${t.id}/${path}`, { stepUpToken: await stepUp(boss, bossCookie, action, t.id) }, bossCookie);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
    for (const c of [one, two]) assert.equal((await call("GET", "/api/auth/me", undefined, c)).status, 401, `${path} ends sessions`);
    if (path === "reset-password") {
      assert.equal(r.headers["cache-control"], "no-store");
      assert.equal((await call("POST", "/api/auth/login", { username: t.username, password: r.body.temporaryPassword })).status, 200);
    }
    if (path === "reset-authenticator") assert.equal((await call("POST", "/api/auth/login", { username: t.username, password: t.password })).body.stage, "totp_setup");
    if (path === "delete") assert.equal((await call("POST", "/api/auth/login", { username: t.username, password: t.password })).status, 401);
  }
  const t = await account("tier1");
  const c = await signIn(t);
  await call("PUT", `/api/admin/users/${t.id}`, { status: "disabled", stepUpToken: await stepUp(boss, bossCookie, "user.update", t.id, { status: "disabled" }) }, bossCookie);
  assert.equal((await call("GET", "/api/auth/me", undefined, c)).status, 401);
});

test("a step-up token for one account's action cannot be used on another account or for another action", async () => {
  const a = await account("tier1");
  const b = await account("tier1");
  const token = await stepUp(boss, bossCookie, "user.password.reset", a.id);
  assert.equal((await call("POST", `/api/admin/users/${b.id}/reset-password`, { stepUpToken: token }, bossCookie)).body.error, "step_up_required");
  assert.equal((await call("POST", `/api/admin/users/${a.id}/delete`, { stepUpToken: token }, bossCookie)).body.error, "step_up_required");
});

test("a deleted username is not free: creating it again offers the deleted account, which an Admin reactivates with a reason that goes into the audit log", async () => {
  const username = `back.${randomBytes(3).toString("hex")}`;
  const body = { username, name: "Back Again", role: "tier1" };
  const made = await call("POST", "/api/admin/users", { ...body, stepUpToken: await stepUp(boss, bossCookie, "user.create", "fleet", body) }, bossCookie);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id as string;
  assert.equal((await call("POST", `/api/admin/users/${id}/delete`, { stepUpToken: await stepUp(boss, bossCookie, "user.delete", id) }, bossCookie)).status, 200);
  // Creating the same username again says so, and names the deleted account.
  const again = await call("POST", "/api/admin/users", { ...body, stepUpToken: await stepUp(boss, bossCookie, "user.create", "fleet", body) }, bossCookie);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "username_deleted");
  assert.equal(again.body.userId, id);
  // Deleted accounts are listed only when asked for; the list has every username.
  const listed = (await call("GET", "/api/admin/users", undefined, bossCookie)).body as { id: string; username: string }[];
  assert.ok(!listed.some(u => u.id === id));
  assert.ok(listed.every(u => typeof u.username === "string" && u.username.length > 0));
  const withDeleted = (await call("GET", "/api/admin/users?deleted=true", undefined, bossCookie)).body as { id: string; username: string; status: string }[];
  assert.equal(withDeleted.find(u => u.id === id)?.status, "deleted");
  assert.equal((await call("GET", "/api/admin/users?deleted=1%27%20OR%201=1", undefined, bossCookie)).status, 400);
  // Only an Admin; a reason is required and checked; the token is bound to this reason.
  const t2 = await account("tier2");
  const t2Cookie = await signIn(t2);
  const reason = "Returned from leave; same person as before.";
  assert.equal((await call("POST", `/api/admin/users/${id}/reactivate`, { reason, stepUpToken: await stepUp(t2, t2Cookie, "user.reactivate", id, { reason }) }, t2Cookie)).status, 403);
  for (const bad of [{}, { reason: "ok" }, { reason: "<script>x</script>" }, { reason, role: "admin" }, { reason: "x".repeat(501) }])
    assert.equal((await call("POST", `/api/admin/users/${id}/reactivate`, { ...bad, stepUpToken: await stepUp(boss, bossCookie, "user.reactivate", id, bad) }, bossCookie)).status, 400, JSON.stringify(bad).slice(0, 60));
  const other = await stepUp(boss, bossCookie, "user.reactivate", id, { reason: "A different reason." });
  assert.equal((await call("POST", `/api/admin/users/${id}/reactivate`, { reason, stepUpToken: other }, bossCookie)).body.error, "step_up_required");
  const ok = await call("POST", `/api/admin/users/${id}/reactivate`, { reason, stepUpToken: await stepUp(boss, bossCookie, "user.reactivate", id, { reason }) }, bossCookie);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.headers["cache-control"], "no-store");
  // The account is back with a new temporary password and a fresh authenticator setup; the reason is in the audit log.
  const login = await call("POST", "/api/auth/login", { username, password: ok.body.temporaryPassword });
  assert.equal(login.status, 200);
  assert.ok(["totp_setup", "password_change"].includes(login.body.stage), login.body.stage);
  const audit = (await db.app.query<any>("SELECT details FROM audit_log WHERE action = 'user.reactivate' AND target_id = $1", [id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.reason, reason);
  assert.equal(audit[0].details.username, username);
  // An account that is not deleted cannot be "reactivated".
  assert.equal((await call("POST", `/api/admin/users/${id}/reactivate`, { reason, stepUpToken: await stepUp(boss, bossCookie, "user.reactivate", id, { reason }) }, bossCookie)).body.error, "not_deleted");
  // The audit list names the person with their username.
  const rows = (await call("GET", "/api/admin/audit?limit=20", undefined, bossCookie)).body;
  assert.ok(JSON.stringify(rows).includes(boss.username));
});

test("each authenticator setup has its own account label, so an old entry in the app is not mistaken for the new one", async () => {
  const a = totp.otpauthUri(totp.newSecret(), "sam");
  const b = totp.otpauthUri(totp.newSecret(), "sam");
  assert.match(a, /^otpauth:\/\/totp\/Mashura%20Support%20Console:sam%20\([A-Z2-7]{4}\)\?/);
  assert.notEqual(a.split("?")[0], b.split("?")[0]);
});

// ---- Sessions, settings and presence -------------------------------------------------------

test("background checks do not count as activity, so an unattended console still times out; the timeout comes from settings", async () => {
  const t = await account("tier1");
  const c = await signIn(t);
  const backdate = (minutes: number) => asOwner(db, k => k.query<any>("UPDATE sessions SET last_activity_at = DATEADD(minute, -$2, SYSUTCDATETIME()) WHERE user_id = $1", [t.id, minutes]));
  await backdate(20);
  assert.equal((await call("GET", "/api/writes/status", undefined, c, { background: true })).status, 200);
  const after = (await db.app.query<{ idle: number }>("SELECT DATEDIFF(second, last_activity_at, SYSUTCDATETIME()) AS idle FROM sessions WHERE user_id = $1", [t.id])).rows[0]!;
  assert.ok(after.idle >= 1190, "a background poll leaves the idle clock running");
  // The Admin shortens the idle timeout to 10 minutes: the 20-minute-idle session is over.
  const r = await call("PUT", "/api/admin/settings", { sessionIdleMinutes: 10, stepUpToken: await stepUp(boss, bossCookie, "settings.update", "fleet", { sessionIdleMinutes: 10 }) }, bossCookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sessionIdleMinutes, 10);
  assert.equal((await call("GET", "/api/auth/me", undefined, c)).status, 401);
  await call("PUT", "/api/admin/settings", { sessionIdleMinutes: 30, stepUpToken: await stepUp(boss, bossCookie, "settings.update", "fleet", { sessionIdleMinutes: 30 }) }, bossCookie);
  assert.equal((await call("PUT", "/api/admin/settings", { sessionIdleMinutes: 1, stepUpToken: "A".repeat(43) }, bossCookie)).status, 400, "out of range");
});

test("the settings carry no drive thresholds any more (D152): none is read back, and a body that sends them is refused", async () => {
  const now = (await call("GET", "/api/admin/settings", undefined, bossCookie)).body;
  assert.equal(now.drives, undefined);
  for (const drives of [{ wearAttentionPct: 75 }, {}])
    assert.equal((await call("PUT", "/api/admin/settings", { drives, stepUpToken: "A".repeat(43) }, bossCookie)).status, 400, JSON.stringify(drives));
});

test("every account, Tier 1 included, sets up an authenticator before anything else; the setting that made it optional is gone", async () => {
  const t = await account("tier1", { totp: false });
  const login = await call("POST", "/api/auth/login", { username: t.username, password: t.password });
  assert.equal(login.body.stage, "totp_setup");
  assert.equal((await call("GET", "/api/fleet/clients", undefined, login.cookie)).status, 401);
  const r = await call("PUT", "/api/admin/settings", { requireTotpForAll: false, stepUpToken: await stepUp(boss, bossCookie, "settings.update", "fleet", { requireTotpForAll: false }) }, bossCookie);
  assert.equal(r.status, 400, "the setting no longer exists");
  assert.equal((await call("GET", "/api/admin/settings", undefined, bossCookie)).body.requireTotpForAll, undefined);
});

test("online now shows who is active, their role and the cabinet they have open; activity answers who looked at this cabinet and when", async () => {
  const t = await account("tier1");
  const c = await signIn(t);
  assert.equal((await call("GET", `/api/fleet/cabinets/${cabinetId}`, undefined, c)).status, 200);
  const online = (await call("GET", "/api/admin/online", undefined, bossCookie)).body as any[];
  const me = online.find(o => o.id === t.id);
  assert.equal(me.cabinet.name, "ICU 1");
  assert.equal(me.role, "tier1");
  await asOwner(db, k => k.query<any>("UPDATE sessions SET last_activity_at = DATEADD(minute, -6, SYSUTCDATETIME()) WHERE user_id = $1", [t.id]));
  assert.ok(!((await call("GET", "/api/admin/online", undefined, bossCookie)).body as any[]).some(o => o.id === t.id), "idle over 5 minutes is not online");

  const activity = (await call("GET", `/api/admin/users/${t.id}/activity`, undefined, bossCookie)).body;
  assert.equal(activity.cabinetsViewed[0].name, "ICU 1");
  assert.ok(activity.actions.some((a: any) => a.action === "cabinet.view" && a.target.name === "ICU 1"));
  const viewers = (await call("GET", `/api/admin/audit?cabinet=${cabinetId}&action=cabinet.view`, undefined, bossCookie)).body as any[];
  assert.ok(viewers.some(v => v.actor.id === t.id && v.actor.name === `Test ${t.username}`));
});

test("the audit search filters by person, cabinet, action (or a family of actions) and date, pages with a cursor, and refuses hostile queries", async () => {
  const all = (await call("GET", "/api/admin/audit?limit=500", undefined, bossCookie)).body as any[];
  assert.ok(all.length > 10);
  const users = (await call("GET", "/api/admin/audit?action=user.", undefined, bossCookie)).body as any[];
  assert.ok(users.length > 0 && users.every(a => a.action.startsWith("user.")));
  const page1 = (await call("GET", "/api/admin/audit?limit=5", undefined, bossCookie)).body as any[];
  const page2 = (await call("GET", `/api/admin/audit?limit=5&before=${page1.at(-1).seq}`, undefined, bossCookie)).body as any[];
  assert.ok(page2[0].seq < page1.at(-1).seq);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(((await call("GET", `/api/admin/audit?from=${today}&to=${today}`, undefined, bossCookie)).body as any[]).length > 0);
  assert.equal(((await call("GET", "/api/admin/audit?to=2000-01-01", undefined, bossCookie)).body as any[]).length, 0);
  for (const q of ["action=x'%20OR%201=1", "action=user.*", "cabinet=nope", "limit=100000", "sort=seq", "from=yesterday"])
    assert.equal((await call("GET", `/api/admin/audit?${q}`, undefined, bossCookie)).status, 400, q);
});

// ---- Clients, sites, roles, issue types, suppressions -------------------------------------

test("clients and sites are created, renamed and removed; one with cabinets cannot be removed, and a removed name can be used again", async () => {
  let r = await call("POST", "/api/admin/clients", { name: "Beta Clinic", stepUpToken: await stepUp(boss, bossCookie, "client.create", "fleet", { name: "Beta Clinic" }) }, bossCookie);
  assert.equal(r.status, 201);
  const beta = r.body.id;
  r = await call("POST", "/api/admin/sites", { clientId: beta, name: "East", stepUpToken: await stepUp(boss, bossCookie, "site.create", beta, { clientId: beta, name: "East" }) }, bossCookie);
  const east = r.body.id;
  assert.equal((await call("PUT", `/api/admin/sites/${east}`, { name: "East Wing", stepUpToken: await stepUp(boss, bossCookie, "site.rename", east, { name: "East Wing" }) }, bossCookie)).status, 200);
  assert.equal((await call("PUT", `/api/admin/clients/${beta}`, { name: "Acme Health", stepUpToken: await stepUp(boss, bossCookie, "client.rename", beta, { name: "Acme Health" }) }, bossCookie)).body.error, "name_taken");
  // The client with an active cabinet stays.
  assert.equal((await call("POST", `/api/admin/clients/${clientId}/remove`, { stepUpToken: await stepUp(boss, bossCookie, "client.remove", clientId) }, bossCookie)).body.error, "has_cabinets");
  assert.equal((await call("POST", `/api/admin/sites/${siteId}/remove`, { stepUpToken: await stepUp(boss, bossCookie, "site.remove", siteId) }, bossCookie)).body.error, "has_cabinets");
  assert.equal((await call("POST", `/api/admin/clients/${beta}/remove`, { stepUpToken: await stepUp(boss, bossCookie, "client.remove", beta) }, bossCookie)).status, 200);
  const list = (await call("GET", "/api/admin/clients", undefined, bossCookie)).body as any[];
  assert.ok(!list.some(c => c.id === beta));
  assert.ok(!((await call("GET", "/api/fleet/clients", undefined, bossCookie)).body as any[]).some(c => c.id === beta));
  assert.equal((await call("POST", "/api/admin/clients", { name: "Beta Clinic", stepUpToken: await stepUp(boss, bossCookie, "client.create", "fleet", { name: "Beta Clinic" }) }, bossCookie)).status, 201);
  assert.equal((await call("POST", "/api/admin/clients", { name: "<img src=x>", stepUpToken: "A".repeat(43) }, bossCookie)).status, 400);
});

test("a cabinet's role is changed by an Admin with step-up", async () => {
  const r = await call("PUT", `/api/admin/cabinets/${cabinetId}/role`, { role: "sync", stepUpToken: await stepUp(boss, bossCookie, "cabinet.role", cabinetId, { role: "sync" }) }, bossCookie);
  assert.equal(r.status, 200);
  assert.equal((await db.app.query<any>("SELECT role FROM cabinets WHERE id = $1", [cabinetId])).rows[0].role, "sync");
  assert.equal((await call("PUT", `/api/admin/cabinets/${cabinetId}/role`, { role: "primary", stepUpToken: "A".repeat(43) }, bossCookie)).status, 400);
});

test("issue types are created and edited; suppressions need a reason, expire after 90 days unless renewed, and are listed on one screen", async () => {
  let r = await call("POST", "/api/admin/issue-types", { name: "Printer offline", severity: "minor", description: "The label printer stopped answering.",
    stepUpToken: await stepUp(boss, bossCookie, "issue_type.create", "fleet", { name: "Printer offline", severity: "minor", description: "The label printer stopped answering." }) }, bossCookie);
  assert.equal(r.status, 201);
  r = await call("PUT", `/api/admin/issue-types/${r.body.id}`, { name: "Label printer offline", severity: "major", description: "The label printer stopped answering.",
    stepUpToken: await stepUp(boss, bossCookie, "issue_type.update", r.body.id, { name: "Label printer offline", severity: "major", description: "The label printer stopped answering." }) }, bossCookie);
  assert.equal(r.status, 200);
  assert.ok(((await call("GET", "/api/issues", undefined, bossCookie)).body as any[]).some(i => i.name === "Label printer offline" && i.severity === "major"));

  assert.equal((await call("POST", "/api/admin/suppressions", { match: { eventId: 109 }, reason: "short", stepUpToken: "A".repeat(43) }, bossCookie)).status, 400);
  r = await call("POST", "/api/admin/suppressions", { match: { log: "System", source: "Kernel-Power", eventId: 109 }, reason: "Logged on every planned restart; harmless.",
    stepUpToken: await stepUp(boss, bossCookie, "rule.suppress", "fleet", { match: { log: "System", source: "Kernel-Power", eventId: 109 }, reason: "Logged on every planned restart; harmless." }) }, bossCookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ruleId = r.body.ruleId;
  const days = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  assert.equal(days(r.body.expiresAt), 90);
  const listed = (await call("GET", "/api/admin/suppressions", undefined, bossCookie)).body as any[];
  assert.equal(listed.find(s => s.id === ruleId).reason, "Logged on every planned restart; harmless.");
  // A matching event is ignored while it is live.
  const ev = { eventId: randomUUID(), kind: "error", occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), severityHint: "minor",
    source: { log: "System", source: "Kernel-Power", eventId: 109, level: "error", recordId: 9 }, detail: { message: "The system has rebooted." } } as const;
  assert.deepEqual((await storeEvents(db.app, cabinetId, { events: [ev] })).outcomes[0]!.kind, "suppressed");
  // Renewing pushes it out again; past its date it expires, with history.
  await asOwner(db, k => k.query<any>("UPDATE symptom_rules SET expires_at = DATEADD(day, 1, SYSUTCDATETIME()) WHERE id = $1", [ruleId]));
  r = await call("POST", `/api/admin/suppressions/${ruleId}/renew`, { stepUpToken: await stepUp(boss, bossCookie, "rule.renew", ruleId) }, bossCookie);
  assert.equal(days(r.body.expiresAt), 90);
  await asOwner(db, k => k.query<any>("UPDATE symptom_rules SET expires_at = DATEADD(minute, -1, SYSUTCDATETIME()) WHERE id = $1", [ruleId]));
  assert.equal(await expireRules(db.app), 1);
  const changes = ((await call("GET", `/api/rules/${ruleId}/history`, undefined, bossCookie)).body as any[]).map(h => h.change);
  assert.deepEqual(changes, ["created", "renewed", "expired"]);
  assert.ok(!((await call("GET", "/api/admin/suppressions", undefined, bossCookie)).body as any[]).some(s => s.id === ruleId));
  // Tier 2 cannot suppress, whatever the console shows.
  const t2 = await account("tier2");
  const t2Cookie = await signIn(t2);
  assert.equal((await call("POST", "/api/admin/suppressions", { match: { eventId: 1 }, reason: "Trying to hide something.", stepUpToken: "A".repeat(43) }, t2Cookie)).status, 403);
});

test("retention removes old events, alerts and firewall history and clears old command results; the audit log is never pruned", async () => {
  const before = (await db.app.query<any>("SELECT COUNT(*) AS n FROM audit_log")).rows[0].n;
  const old = randomUUID(), oldCommand = randomUUID();
  await asOwner(db, async k => {
    await k.query<any>(`INSERT INTO events (event_id, cabinet_id, kind, occurred_at, received_at, detail) VALUES ($1, $2, 'error', DATEADD(day, -200, SYSUTCDATETIME()), DATEADD(day, -200, SYSUTCDATETIME()), '{}')`, [old, cabinetId]);
    await k.query<any>(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at, search_text)
                   VALUES ($1, $2, 'software.list', '{}', $3, DATEADD(day, -100, SYSUTCDATETIME()), DATEADD(day, -99, SYSUTCDATETIME()), 'succeeded', '{"x":1}', DATEADD(day, -100, SYSUTCDATETIME()), 'old program')`, [oldCommand, cabinetId, boss.id]);
  });
  // The newer classes: a network diagnosis, a boot record, and a finished fleet job past their retention (30, 365 and 365
  // days by default); a running job is never removed, however old.
  const [done, running] = [randomUUID(), randomUUID()];
  await asOwner(db, async k => {
    await k.query<any>("INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, commands, started_at) VALUES ($1, $2, 'network', $3, 'done', '[]', DATEADD(day, -40, SYSUTCDATETIME()))", [randomUUID(), cabinetId, boss.id]);
    await k.query<any>("INSERT INTO cabinet_boots (cabinet_id, booted_at, source) VALUES ($1, DATEADD(day, -400, SYSUTCDATETIME()), 'heartbeat')", [cabinetId]);
    for (const [id, state] of [[done, "done"], [running, "running"]])
      await k.query<any>("INSERT INTO fleet_jobs (id, operation, created_by, created_at, batch_size, total, state) VALUES ($1, 'time.sync', $2, DATEADD(day, -400, SYSUTCDATETIME()), 1, 1, $3)", [id, boss.id, state]);
    await k.query<any>("INSERT INTO fleet_job_targets (job_id, cabinet_id, [position], state) VALUES ($1, $2, 0, 'verified')", [done, cabinetId]);
  });
  const run = await runRetention(db.app);
  assert.ok(run.events >= 1 && run.commandResults >= 1);
  // A cleared result takes its search text with it (D63).
  assert.deepEqual((await db.app.query<any>("SELECT result, search_text FROM commands WHERE id = $1", [oldCommand])).rows[0], { result: null, search_text: null });
  assert.ok(run.diagnoses >= 1 && run.boots >= 1);
  assert.equal(run.jobs, 1);
  assert.equal((await db.app.query<any>("SELECT 1 FROM fleet_jobs WHERE id = $1", [running])).rowCount, 1, "a running job is kept");
  assert.equal((await db.app.query<any>("SELECT 1 FROM events WHERE event_id = $1", [old])).rowCount, 0);
  assert.ok((await db.app.query<any>("SELECT COUNT(*) AS n FROM audit_log")).rows[0].n > before);
  assert.equal((await verifyAuditChain(db.app)).ok, true);
});

// ---- Security alerts: one for each trigger in 05-server-spec.md ----------------------------

test("security alert: repeated failed sign-ins and repeated failed step-ups lock the account and tell the Admins", async () => {
  const t = await account("tier2");
  for (let i = 0; i < 5; i++) await call("POST", "/api/auth/login", { username: t.username, password: "wrong password " + i });
  const logins = (await securityAlerts("failed_logins")).filter(a => a.user_id === t.id);
  assert.equal(logins.length, 1);
  assert.match(logins[0]!.title, /Repeated failed sign-ins/);

  const s = await account("tier2");
  const c = await signIn(s);
  for (let i = 0; i < 5; i++) await call("POST", "/api/auth/step-up", { code: "000000", action: "user.create", target: "fleet" }, c);
  assert.equal((await securityAlerts("failed_step_ups")).filter(a => a.user_id === s.id).length, 1);
});

test("security alert: a sign-in from a network the account has not used before, but not from the same network or on a first sign-in", async () => {
  assert.equal(networkOf("10.1.2.3"), "10.1.2.0/24");
  assert.equal(networkOf("::ffff:192.168.7.9"), "192.168.7.0/24");
  assert.equal(networkOf("2001:db8:1:2:3::9"), "2001:db8:1:2::/64");
  const t = await account("tier1");
  await signIn(t, "10.20.30.40");
  await signIn(t, "10.20.30.99");
  assert.equal((await securityAlerts("new_location")).filter(a => a.user_id === t.id).length, 0);
  await signIn(t, "203.0.113.50");
  const alerts = (await securityAlerts("new_location")).filter(a => a.user_id === t.id);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.detail.network, "203.0.113.0/24");
});

test("security alert: unusual write volume pauses the person's writes and tells the Admins", async () => {
  const t = await account("tier2");
  await db.app.query<any>("UPDATE users SET write_limit = 2 WHERE id = $1", [t.id]);
  for (let i = 0; i < 3; i++) {
    const token = await issueStepUpToken(db.app, t.id, "network.setDns", cabinetId, paramsHash({ interfaceIndex: 12, mode: "automatic" }));
    await issueCommand(db.app, t.id, cabinetId, "network.setDns", { interfaceIndex: 12, mode: "automatic" }, "command.issue", { stepUpToken: token }).catch(() => undefined);
  }
  const alerts = (await securityAlerts("write_volume")).filter(a => a.user_id === t.id);
  assert.equal(alerts.length, 1);
  const safety = (await call("GET", "/api/admin/fleet-safety", undefined, bossCookie)).body;
  assert.ok(safety.pausedUsers.some((u: any) => u.id === t.id));
  assert.equal((await call("POST", `/api/admin/users/${t.id}/resume-writes`, { stepUpToken: await stepUp(boss, bossCookie, "user.resume_writes", t.id) }, bossCookie)).status, 200);
  assert.equal((await db.app.query<any>("SELECT writes_paused FROM users WHERE id = $1", [t.id])).rows[0].writes_paused, false);
});

test("security alert: an audit chain break, found by the Admin's check or the daily one", async () => {
  assert.equal((await call("POST", "/api/admin/audit/verify", {}, bossCookie)).body.ok, true);
  const seq = (await db.app.query<{ seq: string }>("SELECT seq FROM audit_log ORDER BY seq OFFSET 3 ROWS FETCH NEXT 1 ROWS ONLY")).rows[0]!.seq;
  await asOwner(db, async k => {
    await k.query<any>("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable");
    await k.query<any>("UPDATE audit_log SET outcome = 'refused' WHERE seq = $1", [seq]);
    await k.query<any>("ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable");
  });
  const r = await call("POST", "/api/admin/audit/verify", {}, bossCookie);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.firstBadSeq, Number(seq));
  const alerts = await securityAlerts("audit_chain");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!.title, new RegExp(`broken at entry ${seq}`));
  // Put it back so the rest of the file has an intact chain.
  await asOwner(db, async k => {
    await k.query<any>("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable");
    await k.query<any>("UPDATE audit_log SET outcome = 'succeeded' WHERE seq = $1", [seq]);
    await k.query<any>("ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable");
  });
});

test("security alert: an agent's failed self-check, a refused package and a signature failure; a safety-net rollback is not one", async () => {
  const at = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const security = (check: string) => ({ eventId: randomUUID(), kind: "security", occurredAt: at(), severityHint: "major", detail: { message: `check ${check}`, fields: { check } } }) as const;
  await storeEvents(db.app, cabinetId, { events: [security("self_check"), security("safety_net_rollback")] });
  assert.equal((await securityAlerts("agent_self_check")).filter(a => a.cabinet_id === cabinetId).length, 1);
  // The agent refuses a package it was sent: the result says which check failed.
  for (const code of ["publisher_not_trusted", "signature_invalid"]) {
    const cmd = randomUUID();
    await asOwner(db, k => k.query<any>(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, delivered_at)
      VALUES ($1, $2, 'package.install', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 10, SYSUTCDATETIME()), 'delivered', SYSUTCDATETIME())`, [cmd, cabinetId, boss.id]));
    await storeResult(db.app, cabinetId, { commandId: cmd, status: "rejected", startedAt: at(), finishedAt: at(), error: { code, message: "refused" } } as any);
  }
  assert.equal((await securityAlerts("package_refused")).filter(a => a.cabinet_id === cabinetId).length, 1);
  assert.equal((await securityAlerts("signature_failure")).filter(a => a.cabinet_id === cabinetId).length, 1);
  void takeQueuedCommands;
});

test("security alerts fold repeats, go to Admins only (list, count and live stream), and closing one needs a note and step-up", async () => {
  const t = await account("tier1");
  for (let round = 0; round < 2; round++) {
    await db.app.query<any>("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = $1", [t.id]);
    for (let i = 0; i < 5; i++) await call("POST", "/api/auth/login", { username: t.username, password: "nope" + i });
  }
  const folded = (await securityAlerts("failed_logins")).filter(a => a.user_id === t.id);
  assert.equal(folded.length, 1);
  assert.equal(folded[0]!.occurrences, 2);

  const t2 = await account("tier2");
  const t2Cookie = await signIn(t2);
  assert.equal((await call("GET", "/api/admin/security-alerts", undefined, t2Cookie)).status, 403);
  const list = (await call("GET", "/api/admin/security-alerts", undefined, bossCookie)).body as any[];
  assert.ok(list.length >= 6);
  assert.ok((await call("GET", "/api/admin/security-alerts/summary", undefined, bossCookie, { background: true })).body.open >= 6);
  const one = list.find(a => a.kind === "failed_logins" && a.user?.id === t.id);
  assert.equal((await call("POST", `/api/admin/security-alerts/${one.id}/resolve`, { stepUpToken: "A".repeat(43) }, bossCookie)).status, 400, "a note is required");
  const r = await call("POST", `/api/admin/security-alerts/${one.id}/resolve`, { note: "They forgot their password; reset it.", stepUpToken: await stepUp(boss, bossCookie, "security_alert.resolve", one.id, { note: "They forgot their password; reset it." }) }, bossCookie);
  assert.equal(r.status, 200);
  const resolved = ((await call("GET", "/api/admin/security-alerts?state=resolved", undefined, bossCookie)).body as any[]).find(a => a.id === one.id);
  assert.equal(resolved.resolution, "They forgot their password; reset it.");
  assert.equal((await call("GET", "/api/admin/security-alerts?state=claimed", undefined, bossCookie)).status, 400);
});

// ---- Roles: every new route, tried by Tier 1 and Tier 2 ------------------------------------

test("every Milestone 6 admin route refuses Tier 1 and Tier 2", async () => {
  const u = randomUUID();
  const routes: [("GET" | "POST" | "PUT"), string, unknown?][] = [
    ["GET", "/api/admin/users"], ["POST", "/api/admin/users", {}], ["PUT", `/api/admin/users/${u}`, {}], ["POST", `/api/admin/users/${u}/delete`, {}],
    ["POST", `/api/admin/users/${u}/reset-password`, {}], ["POST", `/api/admin/users/${u}/reset-authenticator`, {}], ["POST", `/api/admin/users/${u}/resume-writes`, {}],
    ["GET", "/api/admin/online"], ["GET", `/api/admin/users/${u}/activity`], ["GET", "/api/admin/audit"], ["POST", "/api/admin/audit/verify", {}],
    ["GET", "/api/admin/clients"], ["POST", "/api/admin/clients", {}], ["PUT", `/api/admin/clients/${u}`, {}], ["POST", `/api/admin/clients/${u}/remove`, {}],
    ["POST", "/api/admin/sites", {}], ["PUT", `/api/admin/sites/${u}`, {}], ["POST", `/api/admin/sites/${u}/remove`, {}], ["PUT", `/api/admin/cabinets/${u}/role`, {}],
    ["POST", "/api/admin/issue-types", {}], ["PUT", `/api/admin/issue-types/${u}`, {}], ["GET", "/api/admin/suppressions"], ["POST", "/api/admin/suppressions", {}],
    ["POST", `/api/admin/suppressions/${u}/renew`, {}], ["GET", "/api/admin/fleet-safety"], ["GET", "/api/admin/settings"], ["PUT", "/api/admin/settings", {}],
    ["GET", "/api/admin/security-alerts"], ["GET", "/api/admin/security-alerts/summary"], ["POST", `/api/admin/security-alerts/${u}/resolve`, {}],
  ];
  for (const role of ["tier1", "tier2"] as const) {
    const a = await account(role);
    const c = await signIn(a);
    for (const [method, url, body] of routes) assert.equal((await call(method, url, body, c)).status, 403, `${role} ${method} ${url}`);
  }
  for (const [method, url, body] of routes) assert.equal((await call(method, url, body)).status, 401, `signed out ${method} ${url}`);
});

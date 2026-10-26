// The route's own half of Session 1 (docs/platform/control-half-plan.md): POST /api/cabinets/:id/app-control over a real
// database. The decision itself is app-control.test.ts; what this file adds is what only a real run can show - the 202 and
// its body, the queued command row, the audit row each outcome leaves, and that a token bought for another entry or another
// action never reaches the command. A Tier 1 user and a body the contract refuses never reach the service at all.
import test from "node:test";
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
import { paramsHash } from "../src/auth/canonical.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { appsHash, normalizeEntries, rawEntry } from "../src/services/approved-apps.js";
import { SERVICE_CONTROL_STEP_UP } from "../src/services/app-control.js";
import { asOwner, createTestDatabase, startFeed, type TestDatabase } from "./database.js";
import { tempDir, firstCookie } from "./helpers.js";

const ORIGIN = "https://console.test";
const SPOOLER = { key: "app:spooler", kind: "service", name: "Spooler", serviceName: "Spooler", path: "C:\\Windows\\System32\\spoolsv.exe" };
const DISPENSER = { key: "app:dispenser", kind: "application", name: "Dispenser", path: "C:\\Program Files\\Dispenser\\dispenser.exe" };

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
let cabinetId: string;
let outside: string;
const secrets = new SecretBox(randomBytes(32).toString("base64"));

interface Account { id: string; username: string; password: string; secret?: Buffer }
async function account(role: "tier1" | "tier2" | "admin"): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple" };
  a.secret = totp.newSecret();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc)
                      VALUES ($1, $2, $3, $4, $5, 0, 1, $6)`, [a.id, a.username, "Test " + role, role, await hashPassword(a.password), secrets.seal(a.secret)]);
  return a;
}
function nextCode(a: Account): string { clock += 30_000; return totp.code(a.secret!, totp.stepAt(clock)); }
async function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie?: string): Promise<{ status: number; body: any; cookie?: string }> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const r = body === undefined ? await app.inject({ method, url, headers }) : await app.inject({ method, url, headers, payload: JSON.stringify(body) });
  let parsed: unknown = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  const c = firstCookie(r.headers["set-cookie"]);
  return { status: r.statusCode, body: parsed, ...(c ? { cookie: c } : {}) };
}
async function signIn(a: Account): Promise<string> {
  const r = await call("POST", "/api/auth/login", { username: a.username, password: a.password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call("POST", "/api/auth/totp", { code: nextCode(a) }, r.cookie)).body.stage, "complete");
  return r.cookie!;
}
/** A token as a console buys one: for one action on one cabinet, over exactly the parameters it is about to send. */
async function stepUp(a: Account, cookie: string, action: string, target: string, params: unknown): Promise<string> {
  const r = await call("POST", "/api/auth/step-up", { code: nextCode(a), action, target, paramsHash: paramsHash(params) }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
const stored = (raw: unknown[]): string => {
  const one = normalizeEntries(raw);
  assert.equal(one.ok, true, JSON.stringify(one));
  const entries = one.ok ? one.entries : [];
  return JSON.stringify({ version: 4, entries: entries.map(rawEntry), hash: appsHash(entries), setBy: randomUUID(), setAt: "2026-10-01T00:00:00.000Z" });
};
const asJson = (v: unknown): any => (typeof v === "string" ? JSON.parse(v) : v);
const auditRows = async (cabinet: string): Promise<{ outcome: string; details: any }[]> =>
  (await db.app.query<{ outcome: string; details: string }>("SELECT outcome, details FROM audit_log WHERE action = 'app.control' AND target_id = $1 ORDER BY seq", [cabinet]))
    .rows.map(r => ({ outcome: r.outcome, details: asJson(r.details) }));
const commandsFor = async (cabinet: string): Promise<{ id: string; operation: string; params: string; status: string }[]> =>
  (await db.app.query("SELECT id, operation, params, status FROM commands WHERE cabinet_id = $1 AND operation <> 'services.list' ORDER BY issued_at", [cabinet])).rows as any;

test.before(async () => {
  db = await createTestDatabase();
  stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  const staticDir = tempDir();
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Console</title>");
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, staticDir, logger: false, now: () => clock });
  const admin = await account("tier2");
  const clientId = randomUUID(), siteId = randomUUID();
  cabinetId = randomUUID(); outside = randomUUID();
  // Enrolling a cabinet is the platform's own ceremony; the owner writes these rows instead, so this test does not depend
  // on the app login's grants for rows the console never inserts itself.
  await asOwner(db, async c => {
    await c.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [clientId, "Acme Health"]);
    await c.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [siteId, clientId, "North"]);
    for (const id of [cabinetId, outside]) {
      await c.query(`INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at, approved_apps)
                     VALUES ($1, $2, $3, 'sync', 'active', SYSUTCDATETIME(), $4)`,
        [id, siteId, id === cabinetId ? "ICU 1" : "ICU 2", stored(id === cabinetId ? [SPOOLER, DISPENSER] : [DISPENSER])]);
    }
    // The cabinet's own last reading of its services: what "before" is taken from, and the only processes an end may name.
    await c.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
                   VALUES ($1, $2, 'services.list', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'succeeded', $4, DATEADD(second, -30, SYSUTCDATETIME()))`,
      [randomUUID(), cabinetId, admin.id, JSON.stringify({ output: { services: [{ name: "Spooler", state: "running" }] } })]);
  });
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

test("a control request is recorded, queued for the cabinet, and leaves exactly one audit row", async () => {
  const user = await account("tier2");
  const cookie = await signIn(user);
  const sent = { cabinetId, entryKey: "app:spooler", action: "stop" };
  const token = await stepUp(user, cookie, SERVICE_CONTROL_STEP_UP, cabinetId, sent);
  const r = await call("POST", `/api/cabinets/${cabinetId}/app-control`, { ...sent, stepUpToken: token }, cookie);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual({ entryKey: r.body.entryKey, action: r.body.action, operation: r.body.operation, target: r.body.target, before: r.body.before },
    { entryKey: "app:spooler", action: "stop", operation: "service.control", target: { name: "Spooler", action: "stop" }, before: "running" });
  assert.match(String(r.body.commandId), /^[0-9a-f-]{36}$/);
  // The command is the platform's own queue: queued, with the target the entry named and nothing from the body.
  const queued = (await commandsFor(cabinetId)).filter(c => c.id === r.body.commandId);
  assert.equal(queued.length, 1);
  assert.deepEqual([queued[0]!.operation, asJson(queued[0]!.params), queued[0]!.status], ["service.control", { name: "Spooler", action: "stop" }, "queued"]);
  // One row, and it carries the operation, the target, the list it came from and both states.
  const rows = await auditRows(cabinetId);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.deepEqual([rows[0]!.outcome, rows[0]!.details.entryKey, rows[0]!.details.operation, rows[0]!.details.listFrom, rows[0]!.details.before, rows[0]!.details.after],
    ["succeeded", "app:spooler", "service.control", "cabinet", "running", "stopped"]);
  assert.equal(rows[0]!.details.commandId, r.body.commandId);
  // The same token is spent: the same request again is refused, and the refusal is one row of its own with a reason.
  const again = await call("POST", `/api/cabinets/${cabinetId}/app-control`, { ...sent, stepUpToken: token }, cookie);
  assert.deepEqual([again.status, again.body], [403, { error: "step_up_wrong_scope" }]);
  const after = await auditRows(cabinetId);
  assert.equal(after.length, 2);
  assert.deepEqual([after[1]!.outcome, after[1]!.details.reason, after[1]!.details.entryKey], ["refused", "step_up_wrong_scope", "app:spooler"]);
  assert.equal((await commandsFor(cabinetId)).length, 1, "the refusal queued nothing");
});

test("a token bought for another entry, another action or another cabinet never becomes a command", async () => {
  const user = await account("tier2");
  const cookie = await signIn(user);
  const before = (await commandsFor(cabinetId)).length;
  // Confirmed for the dispenser, sent for the spooler.
  const wrongEntry = await stepUp(user, cookie, SERVICE_CONTROL_STEP_UP, cabinetId, { cabinetId, entryKey: "app:dispenser", action: "stop" });
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/app-control`, { cabinetId, entryKey: "app:spooler", action: "stop", stepUpToken: wrongEntry }, cookie)).status, 403);
  // Confirmed for start, sent for stop.
  const wrongAction = await stepUp(user, cookie, SERVICE_CONTROL_STEP_UP, cabinetId, { cabinetId, entryKey: "app:spooler", action: "start" });
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/app-control`, { cabinetId, entryKey: "app:spooler", action: "stop", stepUpToken: wrongAction }, cookie)).status, 403);
  // Confirmed for the other cabinet, sent for this one.
  const wrongCabinet = await stepUp(user, cookie, SERVICE_CONTROL_STEP_UP, outside, { cabinetId: outside, entryKey: "app:dispenser", action: "stop" });
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/app-control`, { cabinetId, entryKey: "app:spooler", action: "stop", stepUpToken: wrongCabinet }, cookie)).status, 403);
  // An entry this cabinet's list does not have, and an action its kind does not allow.
  const spoolerToken = await stepUp(user, cookie, SERVICE_CONTROL_STEP_UP, cabinetId, { cabinetId, entryKey: "app:spooler", action: "start" });
  const notApproved = await call("POST", `/api/cabinets/${outside}/app-control`, { cabinetId: outside, entryKey: "app:spooler", action: "start", stepUpToken: spoolerToken }, cookie);
  assert.deepEqual([notApproved.status, notApproved.body], [403, { error: "control_entry_not_approved" }]);
  const appToken = await stepUp(user, cookie, SERVICE_CONTROL_STEP_UP, cabinetId, { cabinetId, entryKey: "app:dispenser", action: "start" });
  const serviceAction = await call("POST", `/api/cabinets/${cabinetId}/app-control`, { cabinetId, entryKey: "app:dispenser", action: "start", stepUpToken: appToken }, cookie);
  assert.deepEqual([serviceAction.status, serviceAction.body], [403, { error: "control_action_not_allowed" }]);
  assert.equal((await commandsFor(cabinetId)).length, before, "no command was queued by any of the refusals");
  assert.equal((await auditRows(cabinetId)).filter(r => r.outcome !== "succeeded").length >= 4, true, "every refusal left its own row");
});

test("Tier 1 and a body the contract refuses never reach the decision", async () => {
  const tier1 = await account("tier1");
  const cookie = await signIn(tier1);
  const token = "z".repeat(43);
  const queued = (await commandsFor(cabinetId)).length;
  const rows = (await auditRows(cabinetId)).length;
  assert.equal((await call("POST", `/api/cabinets/${cabinetId}/app-control`, { cabinetId, entryKey: "app:spooler", action: "stop", stepUpToken: token }, cookie)).status, 403);
  const tier2 = await account("tier2");
  const cookie2 = await signIn(tier2);
  for (const bad of [
    { entryKey: "app:spooler", action: "stop", stepUpToken: token },
    { cabinetId, action: "stop", stepUpToken: token },
    { cabinetId, entryKey: "app:spooler", stepUpToken: token },
    { cabinetId, entryKey: "app:spooler", action: "STOP", stepUpToken: token },
    { cabinetId, entryKey: "app:spooler", action: "stop", stepUpToken: "short" },
    { cabinetId, entryKey: "app:spooler", action: "stop", stepUpToken: token, serviceName: "Spooler" },
    { cabinetId: "not-a-uuid", entryKey: "app:spooler", action: "stop", stepUpToken: token },
  ]) {
    const r = await call("POST", `/api/cabinets/${cabinetId}/app-control`, bad, cookie2);
    assert.equal(r.status, 400, `${JSON.stringify(bad)} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal((await commandsFor(cabinetId)).length, queued);
  assert.equal((await auditRows(cabinetId)).length, rows, "nothing the contract refused is audited as an attempt");
});

// ---- process.end through the control route, and the generic command route's own rule --------------------------------------------
// Before this, issueFromConsole bound every write's token to the parameters it issued ({processId, name}), not to the request the
// person confirmed, so a control-route end never matched its own token. And the generic route issued service.control and process.end
// for any target: an agent built before the approved list enforces nothing, so the server must.

const DISPENSER_PID = 4242;
async function reportProcesses(cabinet: string, issuer: string): Promise<void> {
  await asOwner(db, c => c.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
                   VALUES ($1, $2, 'processes.list', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'succeeded', $4, SYSUTCDATETIME())`,
    [randomUUID(), cabinet, issuer, JSON.stringify({ output: { processes: [
      { processId: DISPENSER_PID, name: "dispenser", executablePath: DISPENSER.path },
      { processId: 77, name: "notepad", executablePath: "C:\\Windows\\System32\\notepad.exe" },
    ] } })]));
}

test("process.end through the control route is issued with a real token over the request the person confirmed", async () => {
  const user = await account("tier2");
  const cookie = await signIn(user);
  await reportProcesses(cabinetId, user.id);
  const sent = { cabinetId, entryKey: "app:dispenser", action: "end", processId: DISPENSER_PID };
  const token = await stepUp(user, cookie, "process.end", cabinetId, sent);
  const r = await call("POST", `/api/cabinets/${cabinetId}/app-control`, { ...sent, stepUpToken: token }, cookie);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual([r.body.operation, r.body.target], ["process.end", { processId: DISPENSER_PID, name: "dispenser" }]);
  const queued = (await commandsFor(cabinetId)).filter(c => c.id === r.body.commandId);
  assert.deepEqual(queued.map(c => [c.operation, asJson(c.params), c.status]), [["process.end", { processId: DISPENSER_PID, name: "dispenser" }, "queued"]]);
  // The token is spent: the same request again is refused and queues nothing.
  const before = (await commandsFor(cabinetId)).length;
  const again = await call("POST", `/api/cabinets/${cabinetId}/app-control`, { ...sent, stepUpToken: token }, cookie);
  assert.deepEqual([again.status, again.body], [403, { error: "step_up_wrong_scope" }]);
  assert.equal((await commandsFor(cabinetId)).length, before);
});

test("a token bought for the generic {processId, name} body is refused on the control route, and the reverse", async () => {
  const user = await account("tier2");
  const cookie = await signIn(user);
  await reportProcesses(cabinetId, user.id);
  const before = (await commandsFor(cabinetId)).length;
  const generic = { processId: DISPENSER_PID, name: "dispenser" };
  const genericToken = await stepUp(user, cookie, "process.end", cabinetId, generic);
  const viaControl = await call("POST", `/api/cabinets/${cabinetId}/app-control`,
    { cabinetId, entryKey: "app:dispenser", action: "end", processId: DISPENSER_PID, stepUpToken: genericToken }, cookie);
  assert.deepEqual([viaControl.status, viaControl.body], [403, { error: "step_up_wrong_scope" }]);
  // A control-route token on the generic route.
  const controlToken = await stepUp(user, cookie, "process.end", cabinetId, { cabinetId, entryKey: "app:dispenser", action: "end", processId: DISPENSER_PID });
  const viaGeneric = await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "process.end", params: generic, stepUpToken: controlToken }, cookie);
  assert.deepEqual([viaGeneric.status, viaGeneric.body.error], [403, "step_up_required"]);
  assert.equal((await commandsFor(cabinetId)).length, before, "neither mismatch queued a command");
});

test("the generic route issues service.control and process.end only for approved targets, and only with a code", async () => {
  const user = await account("tier2");
  const cookie = await signIn(user);
  await reportProcesses(cabinetId, user.id);
  const send = (operation: string, params: Record<string, unknown>, stepUpToken?: string) =>
    call("POST", `/api/cabinets/${cabinetId}/commands`, { operation, params, ...(stepUpToken ? { stepUpToken } : {}) }, cookie);
  const before = (await commandsFor(cabinetId)).length;

  // service.control: a click in the catalog, but the server asks for a code bound to the parameters.
  assert.equal((await send("service.control", { name: "Spooler", action: "stop" })).status, 403);
  // A service the list does not name (remote access, the agent's own, security software, near-misses) is refused even with a valid code.
  for (const name of ["TermService", "CabinetAgent", "WinDefend", "Spooler2", "Spooler\u0000"]) {
    const params = { name, action: "stop" };
    const token = await stepUp(user, cookie, "service.control", cabinetId, params);
    const r = await send("service.control", params, token);
    assert.ok(r.status === 403 || r.status === 400, `${JSON.stringify(name)} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  // The approved service, in the case Windows ignores, with its own code: issued.
  const ok = { name: "spooler", action: "restart" };
  const issued = await send("service.control", ok, await stepUp(user, cookie, "service.control", cabinetId, ok));
  assert.equal(issued.status, 202, JSON.stringify(issued.body));

  // process.end: an ID running an unapproved program, a name that does not match the ID, an ID never reported.
  for (const [params, code] of [
    [{ processId: 77, name: "notepad" }, "control_process_not_approved"],
    [{ processId: DISPENSER_PID, name: "notepad" }, "control_process_unreported"],
    [{ processId: 99999, name: "dispenser" }, "control_process_unreported"],
  ] as const) {
    const r = await send("process.end", params, await stepUp(user, cookie, "process.end", cabinetId, params));
    assert.equal(r.body.error, code, `${JSON.stringify(params)} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  const end = { processId: DISPENSER_PID, name: "dispenser" };
  assert.equal((await send("process.end", end, await stepUp(user, cookie, "process.end", cabinetId, end))).status, 202);
  assert.equal((await commandsFor(cabinetId)).length, before + 2, "only the two approved targets were queued");

  // The other cabinet's list approves only the dispenser, so it controls no service at all.
  const outsideParams = { name: "Spooler", action: "stop" };
  const r = await call("POST", `/api/cabinets/${outside}/commands`,
    { operation: "service.control", params: outsideParams, stepUpToken: await stepUp(user, cookie, "service.control", outside, outsideParams) }, cookie);
  assert.deepEqual([r.status, r.body.error], [403, "control_entry_not_approved"]);

  // A control body naming another cabinet than the address is refused, never re-aimed at either.
  const mismatch = { cabinetId: outside, entryKey: "app:dispenser", action: "end", processId: DISPENSER_PID };
  const crossed = await call("POST", `/api/cabinets/${cabinetId}/app-control`, { ...mismatch, stepUpToken: await stepUp(user, cookie, "process.end", cabinetId, mismatch) }, cookie);
  assert.deepEqual([crossed.status, crossed.body.error], [400, "invalid_request"]);
});

test("a service's start type is control too: only an approved service, and only with a code", async () => {
  const user = await account("tier2");
  const cookie = await signIn(user);
  const send = (params: Record<string, unknown>, stepUpToken?: string) =>
    call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "service.setStartType", params, ...(stepUpToken ? { stepUpToken } : {}) }, cookie);
  // A click in the catalog; the server asks for a code bound to the parameters.
  assert.equal((await send({ name: "Spooler", startType: "automatic" })).status, 403);
  // Raising or lowering a service the list does not name is refused even with a code: lowering stops it at the next boot.
  for (const params of [{ name: "TermService", startType: "automatic" }, { name: "EventLog", startType: "disabled" }, { name: "W32Time", startType: "manual" }]) {
    const r = await send(params, await stepUp(user, cookie, "service.setStartType", cabinetId, params));
    assert.deepEqual([r.status, r.body.error], [403, "control_entry_not_approved"], JSON.stringify(params));
  }
  const ok = { name: "Spooler", startType: "automatic_delayed" };
  assert.equal((await send(ok, await stepUp(user, cookie, "service.setStartType", cabinetId, ok))).status, 202);
});

test("a process path is matched without regard to case, as Windows and the cabinet do", async () => {
  const user = await account("tier2");
  const cookie = await signIn(user);
  await asOwner(db, c => c.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
                   VALUES ($1, $2, 'processes.list', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'succeeded', $4, DATEADD(second, 5, SYSUTCDATETIME()))`,
    [randomUUID(), cabinetId, user.id, JSON.stringify({ output: { processes: [{ processId: 5151, name: "dispenser", executablePath: DISPENSER.path.toUpperCase() }] } })]));
  const end = { processId: 5151, name: "dispenser" };
  const r = await call("POST", `/api/cabinets/${cabinetId}/commands`, { operation: "process.end", params: end, stepUpToken: await stepUp(user, cookie, "process.end", cabinetId, end) }, cookie);
  assert.equal(r.status, 202, JSON.stringify(r.body));
});

test("an approved-applications write is bound to the body as sent, and a body naming another level or scope is refused", async () => {
  const owner = await account("admin");
  const cookie = await signIn(owner);
  const tier2 = await account("tier2");
  const tier2Cookie = await signIn(tier2);
  const entries = [DISPENSER, SPOOLER];
  const put = (body: Record<string, unknown>, who = cookie) => call("PUT", `/api/cabinets/${outside}/approved-apps`, body, who);
  const tokenFor = (action: string, target: string, params: unknown, who = owner, c = cookie) => stepUp(who, c, action, target, params);

  // Tier 2 never sets a list, whatever it holds.
  const t2body = { level: "cabinet", id: outside, entries };
  assert.equal((await put({ ...t2body, stepUpToken: "A".repeat(43) }, tier2Cookie)).status, 403);
  // The body names another level, or another scope, than the address: refused before the token is looked at.
  for (const body of [{ level: "client", id: outside, entries }, { level: "cabinet", id: cabinetId, entries }, { level: "fleet", id: null, entries }]) {
    const r = await put({ ...body, stepUpToken: await tokenFor("cabinet.apps", outside, body) });
    assert.deepEqual([r.status, r.body.error], [400, "invalid_request"], JSON.stringify(body));
  }
  // A token bought for the server's normalised entries rather than the body as sent does not match.
  const sent = { level: "cabinet", id: outside, entries };
  const normalised = normalizeEntries(entries);
  const wrong = await put({ ...sent, stepUpToken: await tokenFor("cabinet.apps", outside, { level: "cabinet", id: outside, entries: normalised.ok ? normalised.entries : [] }) });
  assert.equal(wrong.status, 403);
  // Bound to exactly what is sent: accepted, and the cabinet's list now names both.
  const ok = await put({ ...sent, stepUpToken: await tokenFor("cabinet.apps", outside, sent) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.effective.entries.map((e: { key: string }) => e.key), ["app:dispenser", "app:spooler"]);
  // Put back what the earlier tests expect.
  const restore = { level: "cabinet", id: outside, entries: [DISPENSER] };
  assert.equal((await put({ ...restore, stepUpToken: await tokenFor("cabinet.apps", outside, restore) })).status, 200);
});

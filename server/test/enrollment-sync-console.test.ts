// The console path of the same rules: the approval body's contract accepts a satellite's sync cabinet, the step-up
// token is bound to it, an Admin assigns satellites and sets sync addresses through their own routes, and a refusal
// reaches the page as a code plus one readable sentence (what the console shows; see console/src/lib/api.ts describeError).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { paramsHash } from "../src/auth/canonical.js";
import { hashPassword } from "../src/auth/passwords.js";
import { SecretBox } from "../src/auth/secrets.js";
import * as totp from "../src/auth/totp.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NULL_BINARY } from "../src/db/db.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { createTestDatabase, startFeed, type TestDatabase } from "./database.js";
import { csrFor, ecKey, firstCookie, tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
const PASSWORD = "correct horse battery staple";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
let cookie: string;
let secret: Buffer;

interface Reply { status: number; body: any; }
async function call(method: "GET" | "POST", url: string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const r = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}), remoteAddress: "10.9.8.7" });
  const c = firstCookie(r.headers["set-cookie"]);
  if (c) cookie = c;
  let parsed: unknown = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}
const nextCode = (): string => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };
async function stepUp(action: string, target: string, params: unknown): Promise<string> {
  const r = await call("POST", "/api/auth/step-up", { code: nextCode(), action, target, paramsHash: paramsHash(params) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
async function pending(): Promise<string> {
  const { token } = await createBootstrapToken(db.app, adminId);
  return submitEnrollment(db.app, {
    csr: csrFor(ecKey()), bootstrapToken: token,
    fingerprints: { hostname: "CAB-" + randomBytes(2).toString("hex"), serialNumber: "SN-" + randomBytes(3).toString("hex"), macAddresses: [],
      provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 10", agentVersion: "0.2.0" },
  }, "127.0.0.1");
}
let adminId: string;

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock });
  adminId = randomUUID();
  secret = totp.newSecret();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'sync.admin', 'Sync Admin', 'admin', $2, 0, 1, $3, 1)`,
    [adminId, await hashPassword(PASSWORD), secrets.seal(secret)]);
  assert.equal((await call("POST", "/api/auth/login", { username: "sync.admin", password: PASSWORD })).status, 200);
  assert.equal((await call("POST", "/api/auth/totp", { code: nextCode() })).body.stage, "complete");
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

async function approve(requestId: string, body: Record<string, unknown>): Promise<Reply> {
  return call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: await stepUp("enrollment.approve", requestId, body) });
}
async function put(url: string, action: string, target: string, body: Record<string, unknown>): Promise<Reply> {
  const r = await app.inject({ method: "PUT", url, headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
    payload: JSON.stringify({ ...body, stepUpToken: await stepUp(action, target, body) }) });
  let parsed: unknown = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}

test("the console approves a satellite with the sync cabinet it reaches, and the token is bound to that choice", async () => {
  const a = await approve(await pending(), { client: "Kilo Health", site: "North", cabinet: "SYNC A", role: "sync" });
  const b = await approve(await pending(), { client: "Kilo Health", site: "North", cabinet: "SYNC B", role: "sync" });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));

  const requestId = await pending();
  const body = { client: "Kilo Health", site: "North", cabinet: "SAT 1", role: "satellite", syncCabinetId: b.body.cabinetId };
  // A token confirmed for the other sync cabinet does not authorize this choice.
  const forOther = await stepUp("enrollment.approve", requestId, { ...body, syncCabinetId: a.body.cabinetId });
  const refused = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: forOther });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "step_up_required");

  const ok = await approve(requestId, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const site = (await call("GET", `/api/fleet/cabinets/${ok.body.cabinetId}`)).body;
  assert.equal(site.sync.state, "address_needed");
  assert.equal(site.sync.syncCabinet.name, "SYNC B");
  assert.equal(site.syncUnassigned, false);
});

test("a refusal the Admin must act on comes back with its own code and one sentence", async () => {
  await approve(await pending(), { client: "Lima Health", site: "East", cabinet: "SYNC A", role: "sync" });
  await approve(await pending(), { client: "Lima Health", site: "East", cabinet: "SYNC B", role: "sync" });
  const r = await approve(await pending(), { client: "Lima Health", site: "East", cabinet: "SAT 1", role: "satellite" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "choose_sync_cabinet");
  assert.match(String(r.body.reason), /Choose the one this satellite reaches/);
});

test("the contract refuses the old address field, a sync cabinet that is not an ID, and one given to a sync cabinet", async () => {
  const requestId = await pending();
  const sat = { client: "Mike Health", site: "North", cabinet: "SAT 1", role: "satellite" };
  for (const extra of [{ sync: { address: "10.0.0.1" } }, { syncCabinetId: "10.0.0.1" }, { syncCabinetId: "'; DROP TABLE cabinets; --" }, { syncCabinetId: null }]) {
    const body = { ...sat, ...extra };
    const r = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: await stepUp("enrollment.approve", requestId, body) });
    assert.equal(r.status, 400, `${JSON.stringify(extra)} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_request");
  }
  const sync = { client: "Mike Health", site: "North", cabinet: "SYNC 1", role: "sync", syncCabinetId: randomUUID() };
  const r = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...sync, stepUpToken: await stepUp("enrollment.approve", requestId, sync) });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error, "invalid_request");
  const row = (await db.app.query<{ status: string }>("SELECT status FROM enrollment_requests WHERE id = $1", [requestId])).rows[0]!;
  assert.equal(row.status, "pending", "none of those bodies approved anything");
});

test("an Admin assigns a satellite and sets a sync address through their routes; the contract refuses hostile values", async () => {
  const sync = (await approve(await pending(), { client: "November Health", site: "North", cabinet: "SYNC 1", role: "sync" })).body.cabinetId as string;
  const sat = (await approve(await pending(), { client: "November Health", site: "North", cabinet: "SAT 1", role: "satellite" })).body.cabinetId as string;

  assert.equal((await put(`/api/admin/cabinets/${sync}/sync-address`, "cabinet.sync_address", sync, { address: "10.50.0.20" })).status, 200);
  assert.equal((await call("GET", `/api/fleet/cabinets/${sat}`)).body.sync.syncCabinet.address, "10.50.0.20");
  for (const address of ["203.0.113.10", "10.50.0.300", "sync.local", "10.50.0.20:1433", 5])
    assert.equal((await put(`/api/admin/cabinets/${sync}/sync-address`, "cabinet.sync_address", sync, { address })).status, 400, String(address));

  assert.equal((await put(`/api/admin/cabinets/${sat}/sync-cabinet`, "cabinet.sync_cabinet", sat, { syncCabinetId: null })).status, 200);
  assert.equal((await call("GET", `/api/fleet/cabinets/${sat}`)).body.syncUnassigned, true);
  const wrong = await put(`/api/admin/cabinets/${sat}/sync-cabinet`, "cabinet.sync_cabinet", sat, { syncCabinetId: sat });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error, "invalid_sync_cabinet");
  assert.equal((await put(`/api/admin/cabinets/${sat}/sync-cabinet`, "cabinet.sync_cabinet", sat, { syncCabinetId: "sync-1" })).status, 400);
  assert.equal((await put(`/api/admin/cabinets/${sat}/sync-cabinet`, "cabinet.sync_cabinet", sat, { syncCabinetId: sync })).status, 200);
  assert.equal((await call("GET", `/api/fleet/cabinets/${sat}`)).body.syncUnassigned, false);
});

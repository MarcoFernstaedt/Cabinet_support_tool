// The console path of the same rules: the approval body's contract accepts the site's sync cabinet, the step-up
// token is bound to it, and a refusal reaches the page as a code plus one readable sentence (what the console
// shows; see console/src/lib/api.ts describeError).
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

test("the console approves a satellite with the site's sync cabinet in one request, and the token is bound to it", async () => {
  const requestId = await pending();
  const body = { client: "Kilo Health", site: "North", cabinet: "SAT 1", role: "satellite", sync: { address: "10.30.0.9", ports: [1433] } };
  // A token confirmed without the sync field does not authorize the request that carries it.
  const forOther = await stepUp("enrollment.approve", requestId, body.client);
  const refused = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: forOther });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "step_up_required");

  const ok = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: await stepUp("enrollment.approve", requestId, body) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.cabinetId);
  const site = (await db.app.query<{ sync_address: string; sync_ports: number[] }>(
    "SELECT s.sync_address, s.sync_ports FROM sites s JOIN clients c ON c.id = s.client_id WHERE c.name = $1 AND s.name = $2", ["Kilo Health", "North"])).rows[0]!;
  assert.equal(site.sync_address, "10.30.0.9");
  assert.deepEqual(site.sync_ports, [1433]);
});

test("a refusal the Admin must act on comes back with its own code and one sentence", async () => {
  const requestId = await pending();
  const body = { client: "Lima Health", site: "East", cabinet: "SAT 1", role: "satellite" };
  const r = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: await stepUp("enrollment.approve", requestId, body) });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "satellite_needs_sync");
  assert.match(String(r.body.reason), /Enter the sync cabinet's private IPv4 address/);
});

test("the contract refuses a public sync address and a sync cabinet given one, before the service is reached", async () => {
  const requestId = await pending();
  const notPendingBehind = await stepUp("enrollment.approve", requestId, { client: "Mike Health", site: "North", cabinet: "SAT 1", role: "satellite" });
  for (const sync of [{ address: "203.0.113.10" }, { address: "10.0.0.1", ports: [1433, 1433] }, { address: "10.0.0.1", ports: [1, 2, 3, 4, 5] }]) {
    const body = { client: "Mike Health", site: "North", cabinet: "SAT 1", role: "satellite", sync };
    const r = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: notPendingBehind });
    assert.equal(r.status, 400, `${JSON.stringify(sync)} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_request");
  }
  // A sync cabinet is the endpoint, so the contract refuses a body that gives it one.
  const sync = { client: "Mike Health", site: "North", cabinet: "SYNC 1", role: "sync", sync: { address: "10.0.0.1" } };
  const r = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...sync, stepUpToken: await stepUp("enrollment.approve", requestId, sync) });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error, "invalid_request");
  // The request is still waiting: none of those bodies approved anything.
  const row = (await db.app.query<{ status: string }>("SELECT status FROM enrollment_requests WHERE id = $1", [requestId])).rows[0]!;
  assert.equal(row.status, "pending");
});

// Scanner IDs and sync ports that follow the client (requested after milestone 7): each set for the fleet, a client,
// a site or (scanner) one cabinet, the most specific applying; changes by role with step-up; and the values reaching
// the agent (its heartbeat answer) and its commands (peripheral.status, network.test).
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
import { scannerIdsFor } from "../src/services/fleet.js";
import { scannerLevels, syncForSite } from "../src/services/device-settings.js";
import { issueFromConsole } from "../src/services/console-commands.js";
import { verifyAuditChain } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
let db: TestDatabase, app: FastifyInstance, stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
interface Account { id: string; username: string; password: string; secret: Buffer; role: "tier1" | "tier2" | "admin"; cookie?: string }
const ids = { client: randomUUID(), otherClient: randomUUID(), site: randomUUID(), site2: randomUUID(), cab: randomUUID(), cab2: randomUUID(), other: randomUUID() };

async function account(role: Account["role"]): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret(), role };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, false, true, $6)`,
    [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(a.secret)]);
  return a;
}
const code = (a: Account) => { clock += 30_000; return totp.code(a.secret, totp.stepAt(clock)); };
async function call(method: "GET" | "PUT", url: string, body?: unknown, cookie?: string) {
  const r = await app.inject({ method, url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  let parsed: any = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}
async function signIn(a: Account): Promise<string> {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: a.username, password: a.password }) });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const r = await app.inject({ method: "POST", url: "/api/auth/totp", headers: { origin: ORIGIN, cookie, "content-type": "application/json" }, payload: JSON.stringify({ code: code(a) }) });
  assert.equal(JSON.parse(r.body).stage, "complete");
  return (a.cookie = cookie);
}
async function token(a: Account, action: string, target: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/auth/step-up", headers: { origin: ORIGIN, cookie: a.cookie!, "content-type": "application/json" },
    payload: JSON.stringify({ code: code(a), action, target }) });
  assert.equal(r.statusCode, 200, r.body);
  return JSON.parse(r.body).token;
}
const put = async (a: Account, url: string, body: Record<string, unknown>, action: string, target: string) =>
  call("PUT", url, { ...body, stepUpToken: await token(a, action, target) }, a.cookie);

let tier1: Account, tier2: Account, admin: Account;

test.before(async () => {
  db = await createTestDatabase();
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => clock });
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Acme Health'), ($2, 'Other Client')", [ids.client, ids.otherClient]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $3, 'North'), ($2, $3, 'South'), ($4, $5, 'Elsewhere')", [ids.site, ids.site2, ids.client, randomUUID(), ids.otherClient]);
  for (const [k, site] of [[ids.cab, ids.site], [ids.cab2, ids.site2]] as const)
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', now())", [k, site, `Cabinet ${k.slice(0, 4)}`]);
  [tier1, tier2, admin] = [await account("tier1"), await account("tier2"), await account("admin")];
  for (const a of [tier1, tier2, admin]) await signIn(a);
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

test("scanner IDs: the cabinet's own, else the site's, else the client's, else the fleet's, else found automatically", async () => {
  assert.deepEqual(await scannerLevels(db.app, ids.cab), { cabinet: null, site: null, client: null, fleet: null, effective: null, source: "automatic" });
  assert.equal(await scannerIdsFor(db.app, ids.cab), null, "the agent finds the scanner itself");

  assert.equal((await put(admin, "/api/settings/scanner", { hardwareIds: ["USB\\VID_1111"] }, "settings.scanner", "fleet")).status, 200);
  assert.deepEqual(await scannerIdsFor(db.app, ids.cab), ["USB\\VID_1111"]);
  // The client changes scanner vendor: one change, every cabinet of that client (only).
  assert.equal((await put(tier2, `/api/clients/${ids.client}/scanner`, { hardwareIds: ["USB\\VID_2222", "USB\\VID_3333&PID_0001"] }, "client.scanner", ids.client)).status, 200);
  assert.deepEqual(await scannerIdsFor(db.app, ids.cab), ["USB\\VID_2222", "USB\\VID_3333&PID_0001"]);
  assert.deepEqual(await scannerIdsFor(db.app, ids.cab2), ["USB\\VID_2222", "USB\\VID_3333&PID_0001"]);
  assert.equal((await scannerLevels(db.app, ids.cab)).source, "client");
  // One site has a different model.
  assert.equal((await put(tier2, `/api/sites/${ids.site}/scanner`, { hardwareIds: ["USB\\VID_4444"] }, "site.scanner", ids.site)).status, 200);
  assert.deepEqual(await scannerIdsFor(db.app, ids.cab), ["USB\\VID_4444"]);
  assert.deepEqual(await scannerIdsFor(db.app, ids.cab2), ["USB\\VID_2222", "USB\\VID_3333&PID_0001"]);
  // And one cabinet its own.
  assert.equal((await put(tier2, `/api/cabinets/${ids.cab}/scanner`, { hardwareIds: ["USB\\VID_5555&PID_0002"] }, "cabinet.scanner", ids.cab)).status, 200);
  assert.equal((await scannerLevels(db.app, ids.cab)).source, "cabinet");
  // Removing levels falls back up the chain.
  assert.equal((await put(tier2, `/api/cabinets/${ids.cab}/scanner`, { hardwareIds: null }, "cabinet.scanner", ids.cab)).status, 200);
  assert.equal((await put(tier2, `/api/sites/${ids.site}/scanner`, { hardwareIds: null }, "site.scanner", ids.site)).status, 200);
  assert.equal((await scannerLevels(db.app, ids.cab)).source, "client");

  // The cabinet page shows every level and where the IDs in use come from; peripheral.status carries them to the agent.
  const page = (await call("GET", `/api/fleet/cabinets/${ids.cab}`, undefined, tier1.cookie)).body;
  assert.deepEqual(page.scanner, { cabinetHardwareIds: null, siteHardwareIds: null, clientHardwareIds: ["USB\\VID_2222", "USB\\VID_3333&PID_0001"], fleetHardwareIds: ["USB\\VID_1111"],
    effective: ["USB\\VID_2222", "USB\\VID_3333&PID_0001"], source: "client" });
  const status = await issueFromConsole(db.app, { userId: tier1.id, role: "tier1" }, ids.cab, "peripheral.status", {});
  assert.deepEqual((status.params as { hardwareIds: string[] }).hardwareIds, ["USB\\VID_2222", "USB\\VID_3333&PID_0001"]);
});

test("scanner IDs: Tier 1 cannot change any level, tokens are bound to their level and target, hostile IDs are refused", async () => {
  assert.equal((await put(tier1, `/api/clients/${ids.client}/scanner`, { hardwareIds: ["USB\\VID_9"] }, "client.scanner", ids.client)).status, 403);
  // A token for the site cannot change the client, nor one client's token another client.
  assert.equal((await put(tier2, `/api/clients/${ids.client}/scanner`, { hardwareIds: ["USB\\VID_9"] }, "site.scanner", ids.client)).status, 403);
  assert.equal((await put(tier2, `/api/clients/${ids.otherClient}/scanner`, { hardwareIds: ["USB\\VID_9"] }, "client.scanner", ids.client)).status, 403);
  for (const bad of [["USB\\VID_1234\"; DROP TABLE clients;--"], ["<script>"], [], Array.from({ length: 17 }, (_, i) => `USB\\VID_${i}`)])
    assert.equal((await call("PUT", `/api/clients/${ids.client}/scanner`, { hardwareIds: bad, stepUpToken: "A".repeat(43) }, tier2.cookie)).status, 400, JSON.stringify(bad));
  assert.equal((await put(tier2, `/api/clients/${randomUUID()}/scanner`, { hardwareIds: null }, "client.scanner", randomUUID())).status, 403);
});

test("sync ports: the site's own, else the client's, else the fleet's; only Admins change them; network.test uses what applies", async () => {
  await db.app.query("UPDATE sites SET sync_address = '10.20.0.15' WHERE id IN ($1, $2)", [ids.site, ids.site2]);
  assert.deepEqual((await syncForSite(db.app, ids.site))!.source, "none");
  assert.equal((await put(tier2, `/api/clients/${ids.client}/sync-ports`, { ports: [1433] }, "client.sync", ids.client)).status, 403, "Admin only");
  assert.equal((await put(admin, "/api/settings/sync-ports", { ports: [445] }, "settings.sync", "fleet")).status, 200);
  assert.deepEqual((await syncForSite(db.app, ids.site))!.effective, [445]);
  // The client's sync software listens elsewhere: one change for all its sites.
  assert.equal((await put(admin, `/api/clients/${ids.client}/sync-ports`, { ports: [1433, 5000] }, "client.sync", ids.client)).status, 200);
  for (const s of [ids.site, ids.site2]) assert.deepEqual(await syncForSite(db.app, s).then(x => [x!.effective, x!.source]), [[1433, 5000], "client"]);
  // One site differs; null brings it back to the client's.
  assert.equal((await put(admin, `/api/sites/${ids.site}/sync`, { address: "10.20.0.15", ports: [8080] }, "site.sync", ids.site)).status, 200);
  assert.deepEqual((await syncForSite(db.app, ids.site))!.effective, [8080]);
  const sitePage = (await call("GET", `/api/fleet/sites/${ids.site}`, undefined, tier1.cookie)).body;
  assert.deepEqual(sitePage.sync, { address: "10.20.0.15", ports: [8080], effectivePorts: [8080], portsSource: "site" });

  const test1 = await issueFromConsole(db.app, { userId: tier1.id, role: "tier1" }, ids.cab, "network.test", { target: "sync_cabinet", method: "tcp", port: 8080, syncPorts: [22, 3389] });
  assert.deepEqual([(test1.params as any).syncAddress, (test1.params as any).syncPorts], ["10.20.0.15", [8080]], "what the browser sent is replaced");
  const test2 = await issueFromConsole(db.app, { userId: tier1.id, role: "tier1" }, ids.cab2, "network.test", { target: "sync_cabinet", method: "tcp", port: 1433 });
  assert.deepEqual((test2.params as any).syncPorts, [1433, 5000]);

  assert.equal((await put(admin, `/api/sites/${ids.site}/sync`, { address: "10.20.0.15", ports: null }, "site.sync", ids.site)).status, 200);
  assert.deepEqual((await syncForSite(db.app, ids.site))!.source, "client");
  assert.equal((await put(admin, `/api/clients/${ids.client}/sync-ports`, { ports: null }, "client.sync", ids.client)).status, 200);
  assert.deepEqual(await syncForSite(db.app, ids.site).then(x => [x!.effective, x!.source]), [[445], "fleet"]);
  for (const bad of [[1, 2, 3, 4, 5], [0], [70000], ["1433"], "1433"])
    assert.equal((await call("PUT", `/api/clients/${ids.client}/sync-ports`, { ports: bad, stepUpToken: "A".repeat(43) }, admin.cookie)).status, 400, JSON.stringify(bad));
  const actions = (await db.app.query<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE action IN ('client.scanner','site.scanner','client.sync','settings.sync') ORDER BY 1")).rows.map(r => r.action);
  assert.deepEqual(actions, ["client.scanner", "client.sync", "settings.sync", "site.scanner"]);
  assert.equal((await verifyAuditChain(db.app)).ok, true);
});

// Sign-ins people can see: the first device an account uses is not "new", the same browser is not new again, another browser is, and so is another
// network; Admins are alerted and can list them; a sign-in counts as completed only once the session has passed every stage.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import { deviceLabel } from "../src/auth/devices.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
const PASSWORD = "correct horse battery staple";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

before(async () => {
  db = await createTestDatabase();
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => clock, trustProxy: 1 });
});
after(async () => { await app.close(); await stream.stop(); await db.drop(); });

async function user(role: "tier1" | "admin") {
  const id = randomUUID(), username = `${role}.${randomBytes(3).toString("hex")}`, secret = totp.newSecret();
  await db.app.query<any>(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, 0, 1, $6)`,
    [id, username, `Test ${role}`, role, await hashPassword(PASSWORD), secrets.seal(secret)]);
  return { id, username, secret };
}

interface Browser { agent: string; ip: string; jar: Map<string, string> }
const browser = (agent: string, ip: string): Browser => ({ agent, ip, jar: new Map() });
const cookieHeader = (b: Browser) => [...b.jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function call(b: Browser, method: "GET" | "POST", url: string, body?: unknown) {
  const headers: Record<string, string> = { origin: ORIGIN, "user-agent": b.agent, "x-forwarded-for": b.ip };
  if (b.jar.size) headers.cookie = cookieHeader(b);
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }), remoteAddress: "127.0.0.1" });
  const set = r.headers["set-cookie"];
  for (const c of Array.isArray(set) ? set : set ? [set] : []) { const [kv] = c.split(";"); const i = kv!.indexOf("="); b.jar.set(kv!.slice(0, i), kv!.slice(i + 1)); }
  let parsed: any = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}
async function signIn(b: Browser, u: Awaited<ReturnType<typeof user>>) {
  const login = await call(b, "POST", "/api/auth/login", { username: u.username, password: PASSWORD });
  assert.equal(login.body.stage, "totp");
  clock += 30_000;
  assert.equal((await call(b, "POST", "/api/auth/totp", { code: totp.code(u.secret, totp.stepAt(clock)) })).body.stage, "complete");
}

test("the cookies carry the __Host- prefix and the device cookie is long-lived", async () => {
  const u = await user("tier1");
  const b = browser(CHROME, "203.0.113.5");
  await call(b, "POST", "/api/auth/login", { username: u.username, password: PASSWORD });
  assert.deepEqual([...b.jar.keys()].sort(), ["__Host-cabinet_device", "__Host-cabinet_session"]);
  assert.match(b.jar.get("__Host-cabinet_device")!, /^[A-Za-z0-9_-]{43}$/);
});

test("first device is not new, the same browser is not new again, another browser and another network are", async () => {
  const u = await user("tier1");
  const home = browser(CHROME, "203.0.113.5");
  await signIn(home, u);
  const me1 = (await call(home, "GET", "/api/auth/me")).body.signIn;
  assert.equal(me1.newDevice, false); assert.equal(me1.newNetwork, false); assert.equal(me1.completed, true);
  assert.equal(me1.device, "Chrome on Windows");

  // The same browser again, from the same network.
  await signIn(home, u);
  assert.equal((await call(home, "GET", "/api/auth/me")).body.signIn.newDevice, false);

  // Another browser on the same network: a new device.
  const other = browser(FIREFOX, "203.0.113.9");
  await signIn(other, u);
  const me2 = (await call(other, "GET", "/api/auth/me")).body.signIn;
  assert.equal(me2.newDevice, true); assert.equal(me2.newNetwork, false); assert.equal(me2.device, "Firefox on Linux");

  // The first browser from a network the account has not used.
  const away = browser(CHROME, "198.51.100.20");
  away.jar.set("__Host-cabinet_device", home.jar.get("__Host-cabinet_device")!);
  await signIn(away, u);
  const me3 = (await call(away, "GET", "/api/auth/me")).body.signIn;
  assert.equal(me3.newDevice, false); assert.equal(me3.newNetwork, true);

  const own = (await call(home, "GET", "/api/auth/sign-ins")).body.signIns as { newDevice: boolean; newNetwork: boolean }[];
  assert.equal(own.length, 4);
  assert.equal(own.filter(s => s.newDevice).length, 1);
  assert.equal(own.filter(s => s.newNetwork).length, 1);

  const alerts = (await db.app.query<{ kind: string }>("SELECT kind FROM security_alerts WHERE user_id = $1 ORDER BY kind", [u.id])).rows.map(r => r.kind);
  assert.deepEqual(alerts, ["new_device", "new_location"]);
});

test("a tampered or malformed device cookie is replaced, never trusted", async () => {
  const u = await user("tier1");
  const b = browser(CHROME, "203.0.113.5");
  await signIn(b, u);
  const second = browser(CHROME, "203.0.113.5");
  second.jar.set("__Host-cabinet_device", "A".repeat(43)); // well formed but unknown
  await signIn(second, u);
  assert.equal((await call(second, "GET", "/api/auth/me")).body.signIn.newDevice, true);
  const junk = browser(CHROME, "203.0.113.5");
  junk.jar.set("__Host-cabinet_device", "<script>alert(1)</script>");
  await signIn(junk, u);
  assert.notEqual(junk.jar.get("__Host-cabinet_device"), "<script>alert(1)</script>");
});

test("an Admin lists every sign-in, or only the new ones; a Tier 1 cannot", async () => {
  const admin = await user("admin"), tier1 = await user("tier1");
  const a = browser(CHROME, "203.0.113.5"), t = browser(CHROME, "203.0.113.6");
  await signIn(a, admin); await signIn(t, tier1);
  await signIn(browser(FIREFOX, "203.0.113.6"), tier1);
  const all = (await call(a, "GET", "/api/admin/sign-ins")).body.signIns as { username: string; newDevice: boolean }[];
  assert.ok(all.some(s => s.username === tier1.username) && all.some(s => s.username === admin.username));
  const fresh = (await call(a, "GET", "/api/admin/sign-ins?scope=new")).body.signIns as { username: string; newDevice: boolean }[];
  assert.ok(fresh.length >= 1 && fresh.every(s => s.newDevice || (s as never as { newNetwork: boolean }).newNetwork));
  assert.equal((await call(a, "GET", "/api/admin/sign-ins?scope=everything")).status, 400);
  assert.equal((await call(t, "GET", "/api/admin/sign-ins")).status, 403);
});

test("a sign-in stays incomplete until the authenticator code is given", async () => {
  const u = await user("tier1");
  const b = browser(CHROME, "203.0.113.5");
  await call(b, "POST", "/api/auth/login", { username: u.username, password: PASSWORD });
  assert.equal((await db.app.query<any>("SELECT completed FROM sign_ins WHERE user_id = $1", [u.id])).rows[0].completed, false);
  clock += 30_000;
  await call(b, "POST", "/api/auth/totp", { code: totp.code(u.secret, totp.stepAt(clock)) });
  assert.equal((await db.app.query<any>("SELECT completed FROM sign_ins WHERE user_id = $1", [u.id])).rows[0].completed, true);
});

test("device labels name the browser and system only", () => {
  assert.equal(deviceLabel(CHROME), "Chrome on Windows");
  assert.equal(deviceLabel(FIREFOX), "Firefox on Linux");
  assert.equal(deviceLabel(undefined), "A browser on an unknown system");
  assert.ok(deviceLabel("x".repeat(100_000)).length < 60);
  assert.equal(deviceLabel("<script>Chrome/1 Windows</script>"), "Chrome on Windows");
});


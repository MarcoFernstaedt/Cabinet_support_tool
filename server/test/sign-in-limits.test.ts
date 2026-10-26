// One person cannot lock everyone else out of sign-in: the address limit counts each address (an IPv6 /64) on its own, and
// past it a browser the account has signed in with before may still sign in, while a new browser, a forged device value or
// another account's device value may not. Wrong answers from a known browser still lock the account itself.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { addressKey, addressLimits } from "../src/console-api/auth-routes.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { createTestDatabase, type TestDatabase, startFeed } from "./database.js";
import { tempDir } from "./helpers.js";
import { DEVICE_COOKIE } from "../src/auth/cookies.js";

const ORIGIN = "https://console.test";
const PASSWORD = "correct horse battery staple";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));

before(async () => {
  db = await createTestDatabase();
  stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => clock, trustProxy: 1 });
});
after(async () => { await app.close(); await stream.stop(); await db.drop(); });

async function user() {
  const id = randomUUID(), username = `tier1.${randomBytes(3).toString("hex")}`, secret = totp.newSecret();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, $2, 'Test', 'tier1', $3, 0, 1, $4)`,
    [id, username, await hashPassword(PASSWORD), secrets.seal(secret)]);
  return { id, username, secret };
}

interface Browser { ip: string; jar: Map<string, string> }
const browser = (ip: string): Browser => ({ ip, jar: new Map() });
async function call(b: Browser, url: string, body: unknown) {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": b.ip, "content-type": "application/json" };
  if (b.jar.size) headers.cookie = [...b.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const r = await app.inject({ method: "POST", url, headers, payload: JSON.stringify(body), remoteAddress: "127.0.0.1" });
  const set = r.headers["set-cookie"];
  for (const c of Array.isArray(set) ? set : set ? [set] : []) { const [kv] = c.split(";"); const i = kv!.indexOf("="); b.jar.set(kv!.slice(0, i), kv!.slice(i + 1)); }
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
async function signIn(b: Browser, u: Awaited<ReturnType<typeof user>>) {
  const login = await call(b, "/api/auth/login", { username: u.username, password: PASSWORD });
  if (login.status !== 200) return login;
  clock += 30_000;
  return call(b, "/api/auth/totp", { code: totp.code(u.secret, totp.stepAt(clock)) });
}
/** Thirty wrong passwords against made-up accounts: the address limit, and no real account locked on the way. */
async function exhaust(ip: string) {
  const attacker = browser(ip);
  for (let i = 0; i < 30; i++) assert.equal((await call(attacker, "/api/auth/login", { username: `nobody.${i}`, password: "wrong" })).status, 401);
  assert.deepEqual((await call(attacker, "/api/auth/login", { username: "nobody.x", password: "wrong" })).body, { error: "too_many_attempts" });
  return attacker;
}

test("thirty wrong sign-ins from one address block that address, and nobody at another address", async () => {
  await exhaust("198.51.100.1");
  const u = await user();
  assert.equal((await signIn(browser("198.51.100.2"), u)).body.stage, "complete");
  // The same holds for IPv6, counted per /64: another address in the attacker's /64 is blocked, another /64 is not.
  await exhaust("2001:db8:1:1::10");
  assert.deepEqual((await call(browser("2001:db8:1:1:ffff::99"), "/api/auth/login", { username: u.username, password: PASSWORD })).body, { error: "too_many_attempts" });
  assert.equal((await signIn(browser("2001:db8:1:2::10"), u)).body.stage, "complete");
});

test("behind a shared address, a browser that signed in before still signs in; a new browser does not", async () => {
  const shared = "203.0.113.50";
  const u = await user();
  const known = browser(shared);
  assert.equal((await signIn(known, u)).body.stage, "complete");
  await exhaust(shared);
  assert.equal((await signIn(known, u)).body.stage, "complete", "the person's own browser is not locked out by someone else's guesses");
  // A new browser at that address is refused before any password is checked: a right password gets the same answer as a wrong one.
  assert.deepEqual((await call(browser(shared), "/api/auth/login", { username: u.username, password: PASSWORD })).body, { error: "too_many_attempts" });
  assert.deepEqual((await call(browser(shared), "/api/auth/login", { username: u.username, password: "wrong" })).body, { error: "too_many_attempts" });
});

test("past the address limit, a forged device value or another account's does not get through", async () => {
  const shared = "203.0.113.60";
  const victim = await user(), other = await user();
  const otherBrowser = browser(shared);
  assert.equal((await signIn(otherBrowser, other)).body.stage, "complete");
  await exhaust(shared);
  const forged = browser(shared); forged.jar.set(DEVICE_COOKIE, randomBytes(32).toString("base64url"));
  const malformed = browser(shared); malformed.jar.set(DEVICE_COOKIE, "'; DROP TABLE users; --");
  for (const b of [forged, malformed, otherBrowser])
    assert.deepEqual((await call(b, "/api/auth/login", { username: victim.username, password: PASSWORD })).body, { error: "too_many_attempts" });
});

test("wrong passwords from a known browser past the address limit still lock the account", async () => {
  const shared = "203.0.113.70";
  const u = await user();
  const known = browser(shared);
  assert.equal((await signIn(known, u)).body.stage, "complete");
  await exhaust(shared);
  for (let i = 0; i < 5; i++) assert.equal((await call(known, "/api/auth/login", { username: u.username, password: "wrong" })).status, 401);
  assert.deepEqual((await call(known, "/api/auth/login", { username: u.username, password: PASSWORD })).body, { error: "account_locked" });
});

test("the steps after the password are not refused by someone else's address limit", async () => {
  const shared = "203.0.113.80";
  const u = await user();
  const known = browser(shared);
  assert.equal((await signIn(known, u)).body.stage, "complete");
  await exhaust(shared);
  // Signed in again from the known browser: the authenticator step works although the address is over its limit.
  const login = await call(known, "/api/auth/login", { username: u.username, password: PASSWORD });
  assert.equal(login.body.stage, "totp");
  clock += 30_000;
  assert.equal((await call(known, "/api/auth/totp", { code: totp.code(u.secret, totp.stepAt(clock)) })).body.stage, "complete");
});

test("a password without the authenticator code does not make a browser trusted", async () => {
  const shared = "203.0.113.90";
  const u = await user();
  const halfway = browser(shared);
  // Someone who has the password but not the authenticator stops at the code step.
  assert.equal((await call(halfway, "/api/auth/login", { username: u.username, password: PASSWORD })).body.stage, "totp");
  await exhaust(shared);
  assert.deepEqual((await call(halfway, "/api/auth/login", { username: u.username, password: PASSWORD })).body, { error: "too_many_attempts" });
});

test("changing the password forgets every other trusted browser; ending all sessions forgets them all", async () => {
  const shared = "203.0.113.100";
  const u = await user();
  const mine = browser(shared), old = browser(shared);
  assert.equal((await signIn(mine, u)).body.stage, "complete");
  assert.equal((await signIn(old, u)).body.stage, "complete");
  const NEW = "a different long passphrase 42";
  assert.equal((await call(mine, "/api/auth/password", { currentPassword: PASSWORD, newPassword: NEW })).body.stage, "complete");
  await exhaust(shared);
  assert.deepEqual((await call(old, "/api/auth/login", { username: u.username, password: NEW })).body, { error: "too_many_attempts" });
  assert.equal((await call(mine, "/api/auth/login", { username: u.username, password: NEW })).body.stage, "totp", "the browser that changed it stays trusted");
  const { endAllSessions } = await import("../src/auth/sessions.js");
  await endAllSessions(db.app, u.id);
  assert.deepEqual((await call(mine, "/api/auth/login", { username: u.username, password: NEW })).body, { error: "too_many_attempts" });
});

test("IPv6 is also limited per /48, so a whole allocation of /64s is not 65,536 separate limits", async () => {
  const attacker = (n: number) => browser(`2001:db8:77:${n.toString(16)}::1`);
  let refused = 0;
  for (let n = 0; n < 5; n++)
    for (let i = 0; i < 30; i++) if ((await call(attacker(n), "/api/auth/login", { username: `nobody.${n}.${i}`, password: "wrong" })).status === 429) refused++;
  assert.equal(refused, 30, "after 120 failures across the /48 the fifth /64 is refused from its first try");
  assert.equal((await signIn(browser("2001:db8:78::1"), await user())).body.stage, "complete", "another /48 is not");
});

test("the address key: IPv4 as is, IPv6 by /64, mapped IPv4 unwrapped, hostile text bounded", () => {
  assert.equal(addressKey("198.51.100.7"), "198.51.100.7");
  assert.equal(addressKey("::ffff:198.51.100.7"), "198.51.100.7");
  assert.equal(addressKey("2001:db8:1:1::10"), addressKey("2001:0db8:0001:0001:ffff:ffff:ffff:ffff"));
  assert.notEqual(addressKey("2001:db8:1:1::10"), addressKey("2001:db8:1:2::10"));
  assert.ok(addressKey(":".repeat(5000)).length <= 64);
  assert.ok(addressKey("x".repeat(5000)).length <= 64);
  assert.deepEqual(addressLimits("198.51.100.7").map(l => l.key), ["198.51.100.7"]);
  assert.deepEqual(addressLimits("2001:db8:1:2::10").map(l => l.key), ["2001:db8:1:2::/64", "2001:db8:1::/48"]);
});

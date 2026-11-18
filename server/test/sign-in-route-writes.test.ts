// What the console's sign-in routes write to the account, through the real routes on a real SQL Server (F3, decision-log D116): a sign-in
// that needs no code clears the failure count and lifts a lock that has run out; a sign-in finished with a code
// records it; a password confirmed for a bulk change clears the count. These were not asserted at the route before D116 moved the writes.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/passwords.js";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { ConsoleHarness, ORIGIN } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  const key = await developmentIssuingKey(tempDir());
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

const row = async (id: string) => (await db.app.query<{ failed_logins: number; locked: boolean; signed_in: boolean }>(
  `SELECT failed_logins, CAST(CASE WHEN locked_until IS NULL THEN 0 ELSE 1 END AS bit) AS locked, CAST(CASE WHEN last_login_at IS NULL THEN 0 ELSE 1 END AS bit) AS signed_in
     FROM users WHERE id = $1`, [id])).rows[0]!;
const login = (username: string, password: string) => app.inject({ method: "POST", url: "/api/auth/login",
  headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username, password }) });

test("a sign-in that needs no code clears the failure count and lifts a lock that has run out; it is not recorded as finished before setup", async () => {
  const id = randomUUID(), username = `plain.${randomBytes(3).toString("hex")}`, password = "correct horse battery staple";
  // A Tier 1 without an authenticator, two failures counted and a lock that has run out.
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, failed_logins, locked_until)
                      VALUES ($1, $2, 'P', 'tier1', $3, 0, 2, DATEADD(minute, -1, SYSUTCDATETIME()))`, [id, username, await hashPassword(password)]);
  const r = await login(username, password);
  assert.equal(r.statusCode, 200, r.body);
  // Every account sets up an authenticator before its sign-in is finished; this step asks for no code, so it clears the count.
  assert.equal(JSON.parse(r.body).stage, "totp_setup");
  assert.deepEqual(await row(id), { failed_logins: 0, locked: false, signed_in: false });
});

test("a sign-in finished with an authenticator code records the sign-in; the password alone does not", async () => {
  const a = await h.account("tier2");
  assert.equal((await row(a.id)).signed_in, true, "signed in through the password and the code");
  await db.app.query("UPDATE users SET last_login_at = NULL, failed_logins = 2 WHERE id = $1", [a.id]);
  const first = await login(a.username, a.password);
  assert.equal(JSON.parse(first.body).stage, "totp");
  assert.deepEqual(await row(a.id), { failed_logins: 2, locked: false, signed_in: false }, "a correct password does not clear the count when a code follows");
  a.cookie = String(first.headers["set-cookie"]).split(";")[0]!;
  assert.equal((await h.call("POST", "/api/auth/totp", { code: h.code(a) }, a)).body.stage, "complete");
  assert.deepEqual(await row(a.id), { failed_logins: 0, locked: false, signed_in: true });
});

test("a password confirmed for a bulk change clears the failure count", async () => {
  const a = await h.account("tier1");
  await db.app.query("UPDATE users SET failed_logins = 2 WHERE id = $1", [a.id]);
  const r = await h.call("POST", "/api/auth/confirm-password", { password: a.password, action: "bulk.firewall_policy", target: randomUUID(), paramsHash: "0".repeat(64) }, a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await row(a.id)).failed_logins, 0);
});

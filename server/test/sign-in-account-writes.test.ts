// The console sign-in's account writes, moved from console-api/auth-routes.ts into users.ts, the users table's owner (F3, F21.R2,
// decision-log D116). Each writes only the account it names, and checks what it is given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { clearAuthFailures, enableAuthenticator, markTourCompleted, pendingAuthenticatorSecret, recordSignedIn, setOwnPassword, spendSignInStep } from "../src/services/users.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function account(): Promise<string> {
  const id = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash, must_change_password, failed_logins, locked_until) VALUES ($1, $2, 'S', 'tier2', 'old', 1, 4, DATEADD(minute, 10, SYSUTCDATETIME()))",
    [id, `sign-${id.slice(0, 8)}`]);
  return id;
}
const row = async (id: string) => (await db.app.query<Record<string, unknown>>(
  `SELECT failed_logins, CAST(CASE WHEN locked_until IS NULL THEN 0 ELSE 1 END AS bit) AS locked, CAST(CASE WHEN last_login_at IS NULL THEN 0 ELSE 1 END AS bit) AS signed_in,
          CONVERT(nvarchar(32), totp_last_step) AS step, totp_enabled, totp_secret_enc, password_hash, must_change_password, tour_completed
     FROM users WHERE id = $1`, [id])).rows[0]!;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("clearing the failure count lifts the lock only when asked; recording a sign-in touches only that account", async () => {
  const a = await account(), b = await account(), other = await account();
  await clearAuthFailures(db.app, a, { unlock: false });
  assert.deepEqual([(await row(a)).failed_logins, (await row(a)).locked], [0, true], "a correct code after a password keeps the lock decision to the route");
  await clearAuthFailures(db.app, b.toUpperCase(), { unlock: true });
  assert.deepEqual([(await row(b)).failed_logins, (await row(b)).locked], [0, false]);
  await recordSignedIn(db.app, a);
  assert.equal((await row(a)).signed_in, true);
  const o = await row(other);
  assert.deepEqual([o.failed_logins, o.locked, o.signed_in], [4, true, false]);
});

test("a sign-in step is spent once and only when newer, clears the count, and records the sign-in only when it completes", async () => {
  const a = await account();
  assert.equal(await spendSignInStep(db.app, a, 500, false), true);
  assert.deepEqual([(await row(a)).step, (await row(a)).failed_logins, (await row(a)).signed_in], ["500", 0, false]);
  assert.equal(await spendSignInStep(db.app, a, 500, true), false, "the same code again");
  assert.equal(await spendSignInStep(db.app, a, 400, true), false, "an older code");
  assert.equal((await row(a)).signed_in, false);
  assert.equal(await spendSignInStep(db.app, a, 501, true), true);
  assert.equal((await row(a)).signed_in, true);
  assert.equal(await spendSignInStep(db.app, randomUUID(), 1, true), false, "no such account");
});

test("authenticator setup keeps the first pending secret, then turns the authenticator on; afterwards there is nothing pending", async () => {
  const a = await account();
  const first = Buffer.from("first-sealed"), second = Buffer.from("second-sealed");
  assert.deepEqual(await pendingAuthenticatorSecret(db.app, a, first), first);
  assert.deepEqual(await pendingAuthenticatorSecret(db.app, a, second), first, "a later request cannot swap the secret being set up");
  await enableAuthenticator(db.app, a, 700);
  assert.deepEqual([(await row(a)).totp_enabled, (await row(a)).step], [true, "700"]);
  assert.equal(await pendingAuthenticatorSecret(db.app, a, second), null, "already on");
  assert.equal(await pendingAuthenticatorSecret(db.app, randomUUID(), second), null, "no such account");
});

test("the chosen password no longer has to be changed; the tour is marked done; another account is not touched", async () => {
  const a = await account(), other = await account();
  await setOwnPassword(db.app, a, "new-hash");
  await markTourCompleted(db.app, a);
  const r = await row(a);
  assert.deepEqual([r.password_hash, r.must_change_password, r.tour_completed], ["new-hash", false, true]);
  const o = await row(other);
  assert.deepEqual([o.password_hash, o.must_change_password, o.tour_completed], ["old", true, false]);
});

test("what each is given is checked before the database is touched, each refusal with its own reason", async () => {
  const id = randomUUID();
  const cases: [string, () => Promise<unknown>, RegExp][] = [
    ["clear: account not a uuid", () => clearAuthFailures(untouched, "1' OR '1'='1", { unlock: true }), /the account must be a uuid/],
    ["clear: no choice", () => clearAuthFailures(untouched, id, undefined as never), /say whether the lock is lifted too/],
    ["clear: choice as text", () => clearAuthFailures(untouched, id, { unlock: "yes" } as never), /say whether the lock is lifted too/],
    ["signed in: account a number", () => recordSignedIn(untouched, 7 as never), /the account must be a uuid/],
    ["step: account missing", () => spendSignInStep(untouched, undefined as never, 1, true), /the account must be a uuid/],
    ["step: negative", () => spendSignInStep(untouched, id, -1, true), /an authenticator step is a whole number, 0 or more/],
    ["step: fraction", () => spendSignInStep(untouched, id, 0.5, true), /an authenticator step is a whole number, 0 or more/],
    ["step: complete as a number", () => spendSignInStep(untouched, id, 1, 1 as never), /say whether the sign-in is complete/],
    ["secret: account with a suffix", () => pendingAuthenticatorSecret(untouched, `${id}x`, Buffer.from("s")), /the account must be a uuid/],
    ["secret: text, not bytes", () => pendingAuthenticatorSecret(untouched, id, "sealed" as never), /a sealed secret is 1 to 1024 bytes/],
    ["secret: empty", () => pendingAuthenticatorSecret(untouched, id, Buffer.alloc(0)), /a sealed secret is 1 to 1024 bytes/],
    ["secret: too long", () => pendingAuthenticatorSecret(untouched, id, Buffer.alloc(1025)), /a sealed secret is 1 to 1024 bytes/],
    ["enable: step as text", () => enableAuthenticator(untouched, id, "700" as never), /an authenticator step is a whole number, 0 or more/],
    ["enable: account a list", () => enableAuthenticator(untouched, [id] as never, 1), /the account must be a uuid/],
    ["password: empty hash", () => setOwnPassword(untouched, id, ""), /a password hash is 1 to 1024 characters with no spaces/],
    ["password: hash with a space", () => setOwnPassword(untouched, id, "a b"), /a password hash is 1 to 1024 characters with no spaces/],
    ["password: account not a uuid", () => setOwnPassword(untouched, "admin", "h"), /the account must be a uuid/],
    ["tour: account an object", () => markTourCompleted(untouched, { id } as never), /the account must be a uuid/],
  ];
  for (const [name, call, reason] of cases) await assert.rejects(call(), reason, name);
  assert.equal(cases.length, 18);
});

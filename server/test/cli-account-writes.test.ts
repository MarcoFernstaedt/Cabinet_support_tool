// The operator command line's account writes, moved from src/cli.ts into users.ts, the users table's owner (F21.R2, decision-log D115):
// spending an authenticator step, resuming a person's writes, adding an account and giving a temporary password. Each writes only the
// account it names, and checks what it is given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { addUserFromCommandLine, resumeWritesByUsername, setTemporaryPasswordByUsername, spendCodeStep } from "../src/services/users.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function account(): Promise<{ id: string; username: string }> {
  const id = randomUUID(), username = `cli-${id.slice(0, 8)}`;
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, $2, 'C', 'admin', 'old-hash')", [id, username]);
  return { id, username };
}
const row = async (id: string) => (await db.app.query<Record<string, unknown>>(
  `SELECT username, name, role, password_hash, must_change_password, failed_logins, CAST(CASE WHEN locked_until IS NULL THEN 0 ELSE 1 END AS bit) AS locked,
          totp_last_step, writes_paused, writes_paused_reason, CAST(CASE WHEN writes_resumed_at IS NULL THEN 0 ELSE 1 END AS bit) AS resumed
     FROM users WHERE id = $1`, [id])).rows[0]!;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("an authenticator step is spent once, only when newer, and clears the failure count; another account is not touched", async () => {
  const a = await account(), b = await account();
  await db.app.query("UPDATE users SET failed_logins = 3 WHERE id IN ($1, $2)", [a.id, b.id]);
  assert.equal(await spendCodeStep(db.app, a.id, 1000), true);
  assert.equal(Number((await row(a.id)).totp_last_step), 1000);
  assert.equal((await row(a.id)).failed_logins, 0);
  assert.equal(await spendCodeStep(db.app, a.id, 1000), false, "the same step again: the code was used before");
  assert.equal(await spendCodeStep(db.app, a.id, 999), false, "an older step");
  assert.equal(await spendCodeStep(db.app, a.id.toUpperCase(), 1001), true);
  assert.equal((await row(b.id)).failed_logins, 3);
  assert.equal(await spendCodeStep(db.app, randomUUID(), 5), false, "no such account");
});

test("resuming writes by username clears the pause and its reason; an unknown or differently cased username is not found", async () => {
  const a = await account(), b = await account();
  await db.app.query("UPDATE users SET writes_paused = 1, writes_paused_reason = 'Under review.' WHERE id IN ($1, $2)", [a.id, b.id]);
  assert.equal((await resumeWritesByUsername(db.app, a.username))!.toLowerCase(), a.id);
  assert.deepEqual([(await row(a.id)).writes_paused, (await row(a.id)).writes_paused_reason, (await row(a.id)).resumed], [false, null, true]);
  assert.equal((await row(b.id)).writes_paused, true);
  assert.equal(await resumeWritesByUsername(db.app, "nobody-here"), null);
  // Usernames are compared exactly, as sign-in does: a capital letter is not the same person (and is not a username at all).
  await assert.rejects(resumeWritesByUsername(db.app, b.username.toUpperCase()), /a username is 2 to 64 characters/);
});

test("an account added from the command line must change its temporary password; a temporary password clears the lock", async () => {
  const id = randomUUID(), username = `new-${id.slice(0, 8)}`;
  await addUserFromCommandLine(db.app, { id, username, name: "New Person", role: "tier2", passwordHash: "temp-hash" });
  assert.deepEqual(await row(id), { username, name: "New Person", role: "tier2", password_hash: "temp-hash", must_change_password: true, failed_logins: 0,
    locked: false, totp_last_step: null, writes_paused: false, writes_paused_reason: null, resumed: false });
  await db.app.query("UPDATE users SET must_change_password = 0, failed_logins = 5, locked_until = DATEADD(minute, 15, SYSUTCDATETIME()) WHERE id = $1", [id]);
  const other = await account();
  assert.equal((await setTemporaryPasswordByUsername(db.app, username, "reset-hash"))!.toLowerCase(), id);
  const r = await row(id);
  assert.deepEqual([r.password_hash, r.must_change_password, r.failed_logins, r.locked], ["reset-hash", true, 0, false]);
  assert.equal((await row(other.id)).password_hash, "old-hash");
  assert.equal(await setTemporaryPasswordByUsername(db.app, "nobody-here", "x"), null);
});

test("what each is given is checked before the database is touched, each refusal with its own reason", async () => {
  const id = randomUUID(), good = { id, username: "fine-name", name: "Fine", role: "tier1", passwordHash: "h" };
  const cases: [string, () => Promise<unknown>, RegExp][] = [
    ["step: account not a uuid", () => spendCodeStep(untouched, "1' OR '1'='1", 1), /the account must be a uuid/],
    ["step: no account", () => spendCodeStep(untouched, undefined as never, 1), /the account must be a uuid/],
    ["step: negative", () => spendCodeStep(untouched, id, -1), /an authenticator step is a whole number, 0 or more/],
    ["step: fraction", () => spendCodeStep(untouched, id, 1.5), /an authenticator step is a whole number, 0 or more/],
    ["step: text", () => spendCodeStep(untouched, id, "5" as never), /an authenticator step is a whole number, 0 or more/],
    ["step: past safe integers", () => spendCodeStep(untouched, id, 2 ** 60), /an authenticator step is a whole number, 0 or more/],
    ["resume: injection", () => resumeWritesByUsername(untouched, "x'; DROP TABLE users; --"), /a username is 2 to 64 characters/],
    ["resume: one character", () => resumeWritesByUsername(untouched, "a"), /a username is 2 to 64 characters/],
    ["resume: too long", () => resumeWritesByUsername(untouched, "a".repeat(65)), /a username is 2 to 64 characters/],
    ["resume: not text", () => resumeWritesByUsername(untouched, ["admin"] as never), /a username is 2 to 64 characters/],
    ["add: not an object", () => addUserFromCommandLine(untouched, null as never), /an account to add is an object/],
    ["add: id not a uuid", () => addUserFromCommandLine(untouched, { ...good, id: "1" }), /the account must be a uuid/],
    ["add: username with a space", () => addUserFromCommandLine(untouched, { ...good, username: "two words" }), /a username is 2 to 64 characters/],
    ["add: empty name", () => addUserFromCommandLine(untouched, { ...good, name: "  " }), /a name is 1 to 128 characters with no control characters/],
    ["add: name too long", () => addUserFromCommandLine(untouched, { ...good, name: "n".repeat(129) }), /a name is 1 to 128 characters with no control characters/],
    ["add: name with a control character", () => addUserFromCommandLine(untouched, { ...good, name: "Ada\u0000Lovelace" }), /a name is 1 to 128 characters with no control characters/],
    ["add: unknown role", () => addUserFromCommandLine(untouched, { ...good, role: "owner" }), /a role is tier1, tier2 or admin/],
    ["add: empty hash", () => addUserFromCommandLine(untouched, { ...good, passwordHash: "" }), /a password hash is 1 to 1024 characters with no spaces/],
    ["reset: bad username", () => setTemporaryPasswordByUsername(untouched, "Admin", "h"), /a username is 2 to 64 characters/],
    ["reset: hash with a space", () => setTemporaryPasswordByUsername(untouched, "fine-name", "a b"), /a password hash is 1 to 1024 characters with no spaces/],
    ["reset: hash too long", () => setTemporaryPasswordByUsername(untouched, "fine-name", "h".repeat(1025)), /a password hash is 1 to 1024 characters with no spaces/],
  ];
  for (const [name, call, reason] of cases) await assert.rejects(call(), reason, name);
  assert.equal(cases.length, 21);
});

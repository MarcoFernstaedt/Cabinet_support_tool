// Counting a failed sign-in or step-up code against an account, moved from auth-failures.ts into users.ts, the users table's owner (F3,
// F21.R2, decision-log D113). The count grows by one, reaching the limit locks the account, a lock that has run out starts the count again
// and is lifted, and what it is given is checked before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { countAuthFailure } from "../src/services/users.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function account(): Promise<{ id: string; username: string }> {
  const id = randomUUID(), username = `fail-${id.slice(0, 8)}`;
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, $2, 'F', 'tier1', 'x')", [id, username]);
  return { id, username };
}
const state = async (id: string) => (await db.app.query<{ failed_logins: number; locked: boolean; minutes: number | null }>(
  `SELECT failed_logins, CAST(CASE WHEN locked_until > SYSUTCDATETIME() THEN 1 ELSE 0 END AS bit) AS locked,
          DATEDIFF(minute, SYSUTCDATETIME(), locked_until) AS minutes FROM users WHERE id = $1`, [id])).rows[0]!;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("each failure counts one; reaching the limit locks the account for its minutes; another account is not touched", async () => {
  const a = await account(), b = await account();
  assert.deepEqual(await countAuthFailure(db.app, a.id, 3, 15), { failures: 1, username: a.username });
  assert.deepEqual(await countAuthFailure(db.app, a.id, 3, 15), { failures: 2, username: a.username });
  assert.equal((await state(a.id)).locked, false, "two of three does not lock");
  assert.deepEqual(await countAuthFailure(db.app, a.id.toUpperCase(), 3, 15), { failures: 3, username: a.username });
  const locked = await state(a.id);
  assert.equal(locked.locked, true);
  assert.ok(locked.minutes! >= 14 && locked.minutes! <= 15, `locked for ${locked.minutes} minutes`);
  assert.deepEqual(await state(b.id), { failed_logins: 0, locked: false, minutes: null });
  assert.equal(await countAuthFailure(db.app, randomUUID(), 3, 15), null, "no such account");
});

test("a lock that has run out starts the count again at one and is lifted", async () => {
  const a = await account();
  await db.app.query("UPDATE users SET failed_logins = 5, locked_until = DATEADD(minute, -1, SYSUTCDATETIME()) WHERE id = $1", [a.id]);
  assert.deepEqual(await countAuthFailure(db.app, a.id, 5, 15), { failures: 1, username: a.username });
  assert.deepEqual(await state(a.id), { failed_logins: 1, locked: false, minutes: null });
});

test("what it is given is checked before the database is touched, each refusal with its own reason", async () => {
  const id = randomUUID();
  const cases: [string, unknown, unknown, unknown, RegExp][] = [
    ["no account", undefined, 5, 15, /the account must be a uuid/],
    ["an account that is not a uuid", "1' OR '1'='1", 5, 15, /the account must be a uuid/],
    ["an account that is a number", 7, 5, 15, /the account must be a uuid/],
    ["a limit of zero", id, 0, 15, /the failures that lock must be a whole number from 1 to 100/],
    ["a limit that is a fraction", id, 2.5, 15, /the failures that lock must be a whole number from 1 to 100/],
    ["a limit that is text", id, "5", 15, /the failures that lock must be a whole number from 1 to 100/],
    ["a limit past 100", id, 101, 15, /the failures that lock must be a whole number from 1 to 100/],
    ["no minutes", id, 5, undefined, /the minutes locked must be a whole number from 1 to 1440/],
    ["negative minutes", id, 5, -15, /the minutes locked must be a whole number from 1 to 1440/],
    ["minutes past a day", id, 5, 1441, /the minutes locked must be a whole number from 1 to 1440/],
    ["minutes that are not a number", id, 5, NaN, /the minutes locked must be a whole number from 1 to 1440/],
  ];
  for (const [name, account, lockAt, minutes, reason] of cases)
    await assert.rejects(countAuthFailure(untouched, account as string, lockAt as number, minutes as number), reason, name);
  assert.equal(cases.length, 11);
});

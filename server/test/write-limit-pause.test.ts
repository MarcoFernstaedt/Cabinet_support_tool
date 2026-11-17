// Pausing a person's writes for going over their hourly limit, moved from writes.ts into users.ts, the users table's owner (F21.R2,
// decision-log D114). The pause sticks, keeps a reason already given, happens once, touches no other account, and the account is checked
// before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pauseUserWritesForLimit } from "../src/services/users.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function account(limit = 40): Promise<{ id: string; username: string }> {
  const id = randomUUID(), username = `pause-${id.slice(0, 8)}`;
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash, write_limit) VALUES ($1, $2, 'P', 'tier2', 'x', $3)", [id, username, limit]);
  return { id, username };
}
const state = async (id: string) => (await db.app.query<{ writes_paused: boolean; writes_paused_reason: string | null }>(
  "SELECT writes_paused, writes_paused_reason FROM users WHERE id = $1", [id])).rows[0]!;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a person over their limit is paused once, with the reason, and answers who and their limit; another account is not touched", async () => {
  const a = await account(25), b = await account();
  assert.deepEqual(await pauseUserWritesForLimit(db.app, a.id.toUpperCase()), { username: a.username, writeLimit: 25 });
  assert.deepEqual(await state(a.id), { writes_paused: true, writes_paused_reason: "Went over the hourly write limit." });
  assert.equal(await pauseUserWritesForLimit(db.app, a.id), null, "already paused: nothing to do, so nothing to audit or alert");
  assert.deepEqual(await state(b.id), { writes_paused: false, writes_paused_reason: null });
  assert.equal(await pauseUserWritesForLimit(db.app, randomUUID()), null, "no such account");
});

test("a reason an Admin already gave is kept; a pause in a transaction that rolls back leaves the account as it was", async () => {
  const a = await account();
  await db.app.query("UPDATE users SET writes_paused_reason = 'Under review.' WHERE id = $1", [a.id]);
  assert.ok(await pauseUserWritesForLimit(db.app, a.id));
  assert.deepEqual(await state(a.id), { writes_paused: true, writes_paused_reason: "Under review." });
  const c = await account();
  await assert.rejects(db.app.transaction(async tx => {
    assert.ok(await pauseUserWritesForLimit(tx, c.id));
    throw new Error("rolled back");
  }), /rolled back/);
  assert.deepEqual(await state(c.id), { writes_paused: false, writes_paused_reason: null });
});

test("the account is checked before the database is touched", async () => {
  for (const bad of [undefined, null, 7, "", "1' OR '1'='1", "not-a-uuid", `${randomUUID()}x`, { id: randomUUID() }, [randomUUID()]])
    await assert.rejects(pauseUserWritesForLimit(untouched, bad as string), /the account must be a uuid/, JSON.stringify(bad));
});

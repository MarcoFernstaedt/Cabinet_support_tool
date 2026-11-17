// Removing a settings row, the counterpart of upsertSetting, now the one place a row is removed (F21.R2, decision-log D117): it removes
// only the key it names, says whether there was one, rolls back with its transaction, and checks the key before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { removeSetting, upsertSetting } from "../src/services/settings.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

const has = async (key: string) => (await db.app.query("SELECT 1 AS x FROM settings WHERE [key] = $1", [key])).rows.length === 1;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a removal takes only the key it names and says whether it was there", async () => {
  const key = `test.remove:${randomUUID()}`, other = `test.keep:${randomUUID()}`;
  await db.app.transaction(async c => { await upsertSetting(c, key, { a: 1 }, null); await upsertSetting(c, other, { b: 2 }, null); });
  assert.equal(await db.app.transaction(c => removeSetting(c, key)), true);
  assert.equal(await has(key), false);
  assert.equal(await has(other), true, "another key stays");
  assert.equal(await db.app.transaction(c => removeSetting(c, key)), false, "nothing left to remove");
});

test("a removal in a transaction that rolls back leaves the row; a write after a removal in one transaction adds it back", async () => {
  const key = `test.rollback:${randomUUID()}`;
  await db.app.transaction(c => upsertSetting(c, key, { v: 1 }, null));
  await assert.rejects(db.app.transaction(async c => {
    assert.equal(await removeSetting(c, key), true);
    throw new Error("rolled back");
  }), /rolled back/);
  assert.equal(await has(key), true);
  await db.app.transaction(async c => { await removeSetting(c, key); await upsertSetting(c, key, { v: 2 }, null); });
  assert.deepEqual((await db.app.query<{ v: string }>("SELECT [value] AS v FROM settings WHERE [key] = $1", [key])).rows[0]!.v, JSON.stringify({ v: 2 }));
});

test("the key is checked before the database is touched", async () => {
  const bad: unknown[] = [undefined, null, 7, "", "a".repeat(201), "time.zone'; DELETE FROM settings; --", "has space", "slash/key", "per%cent", "new\nline",
    ["time.zone"], { key: "time.zone" }];
  for (const key of bad)
    await assert.rejects(removeSetting(untouched, key as string), /a settings key is 1 to 200 letters, digits, dots, colons, dashes or underscores/, JSON.stringify(key));
  assert.equal(bad.length, 12);
});

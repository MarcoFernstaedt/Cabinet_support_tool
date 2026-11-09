// Every row of sign_ins is written by auth/sessions.ts, its owner (F21.R2, decision-log D70). What it is given is checked against the
// table's own rules before anything is written.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { addSignIn, type SignInRow } from "../src/auth/sessions.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
const user = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'sign.in', 'Sign In', 'tier1')", [user]);
});
test.after(async () => { await db?.drop(); });
const count = async () => Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM sign_ins")).rows[0]!.n);
const ok: SignInRow = { userId: user, address: "203.0.113.7", network: "203.0.113.0/24", deviceLabel: "Edge on Windows", newNetwork: false, newDevice: true };

test("each sign-in is one row, returned by its id", async () => {
  const a = await addSignIn(db.app, ok), b = await addSignIn(db.app, ok);
  assert.ok(Number.isInteger(a) && b > a);
  const row = (await db.app.query<{ address: string; new_device: boolean; completed: boolean }>("SELECT address, new_device, completed FROM sign_ins WHERE id = $1", [a])).rows[0]!;
  assert.deepEqual([row.address, row.new_device, row.completed], ["203.0.113.7", true, false]);
});

test("a malformed or hostile sign-in is refused before anything is written", async () => {
  const before = await count();
  for (const bad of [{ userId: "" }, { userId: "' OR 1=1 --" }, { userId: null }, { address: "" }, { address: "a".repeat(65) }, { network: "" }, { network: 7 },
    { deviceLabel: "" }, { deviceLabel: "d".repeat(121) }, { newNetwork: "yes" }, { newDevice: 1 }, { newDevice: null }])
    await assert.rejects(addSignIn(db.app, { ...ok, ...bad } as never), /sign-in/, JSON.stringify(bad));
  await assert.rejects(addSignIn(db.app, null as never), /sign-in/);
  assert.equal(await count(), before, "nothing was written");
});

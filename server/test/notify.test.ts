// Every write to notifications goes through notify() in db.ts (F21.R2, decision-log D68). The channel is checked before anything is
// written, and the payload is cut to the column.
import test from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });
const count = async () => Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM notifications")).rows[0]!.n);

test("a notification on a named channel is written, its payload cut to the column", async () => {
  const before = await count();
  await notify(db.app, "certificates_revoked", "x".repeat(600));
  assert.equal(await count(), before + 1);
  const row = (await db.app.query<{ channel: string; payload: string }>("SELECT TOP (1) channel, payload FROM notifications ORDER BY id DESC")).rows[0]!;
  assert.deepEqual([row.channel, row.payload.length], ["certificates_revoked", 450]);
});

test("a channel that is not a plain lower-case name, or a payload that is not text, is refused before anything is written", async () => {
  const before = await count();
  for (const channel of ["", "Fleet_Patterns", "fleet patterns", "fleet-patterns", "a".repeat(41), "x'; DROP TABLE notifications; --", "fleet_patterns\n", null, 5])
    await assert.rejects(notify(db.app, channel as never, "p"), /notification channel/, JSON.stringify(channel));
  for (const payload of [null, undefined, 12, { a: 1 }])
    await assert.rejects(notify(db.app, "fleet_patterns", payload as never), /notification payload/, JSON.stringify(payload));
  assert.equal(await count(), before, "nothing was written");
});

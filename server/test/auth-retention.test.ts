// Expired sessions and step-up tokens are removed by their own modules (F21.R2, decision-log D71): only what expired before the cut-off,
// each batch audited; a cut-off that is not a past time is refused before anything is removed; running it again removes nothing more.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pruneExpiredSessions } from "../src/auth/sessions.js";
import { pruneExpiredStepUpTokens } from "../src/auth/stepup.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
const user = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'retain.me', 'Retain', 'tier1')", [user]);
});
test.after(async () => { await db?.drop(); });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const session = (expires: Date) => db.app.query("INSERT INTO sessions (id_hash, user_id, stage, expires_at) VALUES ($1, $2, 'complete', $3)", [randomBytes(32), user, expires]);
const token = (expires: Date) => db.app.query("INSERT INTO step_up_tokens (token_hash, user_id, action, target, expires_at) VALUES ($1, $2, 'x', 'y', $3)", [randomBytes(32), user, expires]);
const count = async (table: string) => Number((await db.app.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = $1`, [user])).rows[0]!.n);

for (const [table, add, prune] of [["sessions", session, pruneExpiredSessions], ["step_up_tokens", token, pruneExpiredStepUpTokens]] as const) {
  test(`${table}: only what expired before the cut-off goes, audited; again removes nothing`, async () => {
    await db.app.query(`DELETE FROM ${table} WHERE user_id = $1`, [user]);
    await add(hoursAgo(48)); await add(hoursAgo(30)); await add(hoursAgo(2)); await add(new Date(Date.now() + 3_600_000));
    const cutoff = hoursAgo(24);
    assert.equal(await prune(db.app, cutoff), 2);
    assert.equal(await count(table), 2, "the two that expired after the cut-off, and the live one, stay");
    assert.equal(await prune(db.app, cutoff), 0);
    const logged = (await db.app.query<{ details: { table: string; rows: number } }>(
      "SELECT details FROM audit_log WHERE action = 'retention.batch' AND JSON_VALUE(details, '$.table') = $1", [table])).rows.map(r => r.details.rows);
    assert.deepEqual(logged, [2], "one audited batch; the empty repeat logs nothing");
  });

  test(`${table}: a cut-off that is not a time already passed is refused before anything is removed`, async () => {
    await add(hoursAgo(72));
    const before = await count(table);
    for (const bad of [new Date(Date.now() + 60_000), new Date("not a date"), "2026-01-01", Date.now() - 1000, null, undefined])
      await assert.rejects(prune(db.app, bad as never), /retention cut-off/, String(bad));
    assert.equal(await count(table), before);
  });
}

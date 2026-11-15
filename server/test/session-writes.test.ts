// The two writes to sessions that the console routes made themselves, moved behind auth/sessions.ts, the table's owner (F21.R2,
// decision-log D86): the cabinet a session has open, and ending a user's other sessions after they change their own password. Each checks
// the session hash and the id it is given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSession, endOtherSessions, hashId, setCurrentCabinet } from "../src/auth/sessions.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function user(): Promise<string> {
  const id = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, $2, 'U', 'tier1')", [id, `s.${id.slice(0, 8)}`]);
  return id;
}
async function cabinet(): Promise<string> {
  const client = randomUUID(), site = randomUUID(), k = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [k, site]);
  return k;
}
const current = async (sessionId: string) => (await db.app.query<{ c: string | null }>("SELECT current_cabinet AS c FROM sessions WHERE id_hash = $1", [hashId(sessionId)])).rows[0]?.c ?? null;
const sessionsOf = async (userId: string) => (await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = $1", [userId])).rows[0]!.n;

test("a session records the cabinet it has open, and no other session changes", async () => {
  const u = await user(), k = await cabinet();
  const mine = await createSession(db.app, u, "complete", "10.0.0.1"), other = await createSession(db.app, u, "complete", "10.0.0.2");
  await setCurrentCabinet(db.app, hashId(mine), k);
  assert.equal((await current(mine))?.toLowerCase(), k.toLowerCase());
  assert.equal(await current(other), null);
});

test("ending a user's other sessions keeps the one given, and leaves other users alone", async () => {
  const u = await user(), someoneElse = await user();
  const keep = await createSession(db.app, u, "complete", "10.0.0.1");
  await createSession(db.app, u, "complete", "10.0.0.2");
  await createSession(db.app, u, "password_change", "10.0.0.3");
  await createSession(db.app, someoneElse, "complete", "10.0.0.4");
  assert.equal(await endOtherSessions(db.app, u, hashId(keep)), 2);
  assert.equal(await sessionsOf(u), 1);
  assert.ok((await db.app.query("SELECT 1 FROM sessions WHERE id_hash = $1", [hashId(keep)])).rows[0], "the session that changed the password stays");
  assert.equal(await sessionsOf(someoneElse), 1);
  assert.equal(await endOtherSessions(db.app, u, hashId(keep)), 0, "a repeat ends nothing more");
});

test("anything but a session hash and an id is refused before the database is touched", async () => {
  const u = await user(), k = await cabinet();
  const keep = await createSession(db.app, u, "complete", "10.0.0.1"), other = await createSession(db.app, u, "complete", "10.0.0.2");
  const badHashes: unknown[] = [undefined, null, "", hashId(keep).toString("hex"), Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), [1, 2, 3], {}];
  const badIds: unknown[] = [undefined, null, "", "not-an-id", "' OR 1=1 --", `${k}; DELETE FROM sessions`, 42, {}];
  for (const h of badHashes) {
    await assert.rejects(setCurrentCabinet(db.app, h as never, k), /session hash/, String(h));
    await assert.rejects(endOtherSessions(db.app, u, h as never), /session to keep/, String(h));
  }
  for (const id of badIds) {
    await assert.rejects(setCurrentCabinet(db.app, hashId(keep), id as never), /cabinet id/, String(id));
    await assert.rejects(endOtherSessions(db.app, id as never, hashId(keep)), /user id/, String(id));
  }
  assert.equal(await current(keep), null, "no cabinet was recorded");
  assert.equal(await sessionsOf(u), 2, "no session was ended");
  void other;
});

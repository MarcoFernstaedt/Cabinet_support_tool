// The withdrawal of a fleet job's outstanding commands, moved from fleet-jobs.ts into commands.ts, the table's owner (F21.R2,
// decision-log D103). A queued or delivered command among those given is withdrawn when its batch's budget has passed, or at once while
// it is undelivered to a cabinet not heard from; it becomes expired when delivered or the cabinet is offline, else failed. Each
// withdrawal is audited as command.expire naming the job. What it is given is checked before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WITHDRAW_LIMIT, withdrawJobCommands } from "../src/services/commands.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

const OFFLINE = 300, BUDGET = 60_000;

async function place(): Promise<{ online: string; offline: string; user: string }> {
  const client = randomUUID(), site = randomUUID(), online = randomUUID(), offline = randomUUID(), user = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES
    ($1, $3, 'ON', 'standalone', 'active', SYSUTCDATETIME()), ($2, $3, 'OFF', 'standalone', 'active', DATEADD(hour, -2, SYSUTCDATETIME()))`, [online, offline, site]);
  await db.app.query("INSERT INTO users (id, username, name, role, status, password_hash) VALUES ($1, $2, 'U', 'admin', 'active', 'x')", [user, `u-${user.slice(0, 8)}`]);
  return { online, offline, user };
}
/** A command issued `agoMs` ago, expiring an hour after it was issued, in the given state. */
async function command(cabinet: string, user: string, job: string, o: { agoMs: number; status?: string; delivered?: boolean }): Promise<string> {
  const id = randomUUID();
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id, delivered_at)
    VALUES ($1, $2, 'time.sync', '{}', $3, DATEADD(millisecond, -$4, SYSUTCDATETIME()), DATEADD(millisecond, 3600000 - $4, SYSUTCDATETIME()), $5, $6,
            CASE WHEN $7 = 1 THEN SYSUTCDATETIME() ELSE NULL END)`, [id, cabinet, user, o.agoMs, o.status ?? "queued", job, o.delivered ? 1 : 0]);
  return id;
}
const stored = async (id: string) => (await db.app.query<{ status: string; ok: number }>(
  "SELECT status, CASE WHEN expires_at > issued_at THEN 1 ELSE 0 END AS ok FROM commands WHERE id = $1", [id])).rows[0]!;
const audits = async (ids: string[]) => (await db.app.query<{ target_id: string; actor_kind: string; actor_id: string; details: Record<string, unknown> }>(
  "SELECT target_id, actor_kind, actor_id, details FROM audit_log WHERE action = 'command.expire' AND target_id IN (SELECT value FROM OPENJSON($1))", [JSON.stringify(ids)])).rows;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a withdrawal takes back what is overdue or stuck on an offline cabinet, as expired or failed, audited once each, and nothing else", async () => {
  const { online, offline, user } = await place();
  const job = randomUUID();
  const stuck = await command(offline, user, job, { agoMs: 1_000 });                         // queued, undelivered, cabinet offline: expired at once
  const waiting = await command(online, user, job, { agoMs: 1_000 });                        // queued to an online cabinet, within budget: stays
  const overdue = await command(online, user, job, { agoMs: 120_000 });                      // undelivered to an online cabinet, past budget: failed
  const deliveredLate = await command(online, user, job, { agoMs: 120_000, status: "delivered", delivered: true }); // delivered, past budget: expired
  const answered = await command(online, user, job, { agoMs: 120_000, status: "succeeded", delivered: true });     // finished: stays
  const notGiven = await command(offline, user, job, { agoMs: 120_000 });                    // not asked about: stays
  const given = [stuck, waiting, overdue, deliveredLate, answered];
  const out = await db.app.transaction(tx => withdrawJobCommands(tx, job, given, OFFLINE, BUDGET));
  const by = new Map(out.map(r => [r.id.toLowerCase(), r]));
  assert.deepEqual([...by.keys()].sort(), [stuck, overdue, deliveredLate].sort());
  assert.deepEqual([by.get(stuck)!.status, by.get(overdue)!.status, by.get(deliveredLate)!.status], ["expired", "failed", "expired"]);
  assert.deepEqual([stuck, overdue, deliveredLate].map(id => Boolean(by.get(id)!.delivered)), [false, false, true]);
  assert.deepEqual([(await stored(waiting)).status, (await stored(answered)).status, (await stored(notGiven)).status], ["queued", "succeeded", "queued"]);
  for (const id of [stuck, overdue, deliveredLate]) assert.equal((await stored(id)).ok, 1, "the expiry stays after the issue time");
  const rows = await audits([...given, notGiven]);
  assert.deepEqual(rows.map(r => r.target_id).sort(), [stuck, overdue, deliveredLate].sort());
  for (const r of rows) {
    assert.equal(r.actor_kind, "system"); assert.equal(r.actor_id, "command-expiry");
    assert.equal(r.details.jobId, job); assert.equal(r.details.why, "fleet-job-withdrawal"); assert.equal(r.details.automatic, true);
    assert.equal(r.details.operation, "time.sync");
  }
  assert.equal(rows.find(r => r.target_id === stuck)!.details.cabinetId, offline);
  assert.equal(rows.find(r => r.target_id === deliveredLate)!.details.delivered, true);
  // A repeat withdraws and audits nothing more.
  assert.equal((await db.app.transaction(tx => withdrawJobCommands(tx, job, given, OFFLINE, BUDGET))).length, 0);
  assert.equal((await audits(given)).length, 3);
});

test("a budget of 0 withdraws every outstanding command at once", async () => {
  const { online, user } = await place();
  const job = randomUUID();
  const fresh = await command(online, user, job, { agoMs: 0 });
  const out = await db.app.transaction(tx => withdrawJobCommands(tx, job, [fresh], OFFLINE, 0));
  assert.deepEqual(out.map(r => [r.id.toLowerCase(), r.status]), [[fresh, "failed"]]);
  assert.equal((await stored(fresh)).ok, 1, "an immediate withdrawal keeps the expiry after the issue time");
});

test("a withdrawal in a transaction that rolls back leaves the command queued and unaudited", async () => {
  const { offline, user } = await place();
  const job = randomUUID();
  const id = await command(offline, user, job, { agoMs: 1_000 });
  await assert.rejects(db.app.transaction(async tx => {
    assert.equal((await withdrawJobCommands(tx, job, [id], OFFLINE, BUDGET)).length, 1);
    throw new Error("rolled back");
  }), /rolled back/);
  assert.equal((await stored(id)).status, "queued");
  assert.equal((await audits([id])).length, 0);
});

test("anything but a job, 1 to 200 command ids and whole windows is refused before the database is touched", async () => {
  const id = randomUUID(), job = randomUUID();
  const badIds = [undefined, null, "", "not-an-id", `${id}'; DROP TABLE commands; --`, 42];
  let refused = 0;
  const refuse = async (p: Promise<unknown>, why: RegExp, what: string) => {
    await assert.rejects(p, (e: Error) => why.test(e.message), what); refused++;
  };
  for (const v of badIds) await refuse(withdrawJobCommands(untouched, v as never, [id], OFFLINE, BUDGET), /job's id is required/, `job ${String(v)}`);
  const tooMany = Array.from({ length: WITHDRAW_LIMIT + 1 }, () => randomUUID());
  for (const ids of [undefined, null, "", [], id, [id, "not-an-id"], [`${id}'; DROP TABLE commands; --`], [42], tooMany, { length: 1, 0: id }])
    await refuse(withdrawJobCommands(untouched, job, ids as never, OFFLINE, BUDGET), /command ids are required/, `ids ${String(ids).slice(0, 40)}`);
  for (const s of [undefined, 0, -1, 1.5, Number.NaN, 86_401, "300"])
    await refuse(withdrawJobCommands(untouched, job, [id], s as never, BUDGET), /offline window/, `offline ${String(s)}`);
  for (const b of [undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001, "60000"])
    await refuse(withdrawJobCommands(untouched, job, [id], OFFLINE, b as never), /answer budget/, `budget ${String(b)}`);
  assert.equal(refused, 30);
});

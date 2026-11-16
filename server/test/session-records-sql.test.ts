// Real migrated schema, through the production application role. No repository mock.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { verifyAuditChain } from "../src/db/db.js";
import { closeSessionRecord, insertSessionRecord, recordSessionRefusal, refuseAgentSession, sessionRecord } from "../src/services/session-records.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { SessionLifecycle, SESSION_IDLE_MS, SESSION_MAX_MS } from "../src/services/session-lifecycle.js";
import { grantPermission } from "../src/services/user-permissions.js";
import { SessionRelay } from "../src/agent-api/session-relay.js";

let db: TestDatabase | undefined;
const operator = randomUUID(), cabinet = randomUUID();
const actor = { actorKind: "user" as const, actorId: operator };
test.before(async () => {
  db = await createTestDatabase();
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'session-operator', 'Session operator', 'tier2')", [operator]);
  await db.app.transaction(tx => grantPermission(tx, operator, operator, "session.open", "fleet", null));
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Session client')", [client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Session site')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'Session cabinet', 'standalone', 'active')", [cabinet, site]);
});
test.after(async () => { await db?.drop(); });

const open = (reason: string) => db!.app.transaction(tx => insertSessionRecord(tx, { cabinetId: cabinet, operatorId: operator, kind: "diagnostic", reason }));
const entries = async (id: string) => (await db!.app.query<{ action: string; details: { reason: string } }>(
  "SELECT action, details FROM audit_log WHERE JSON_VALUE(details, '$.sessionId') = $1 ORDER BY seq", [id])).rows;

test("open, explicit close and kill preserve the record and append exactly one audit row per transition", async () => {
  const id = await open("Find why the cabinet failed");
  const record = (await sessionRecord(db!.app, id))!;
  assert.equal(record.cabinet_id, cabinet);
  assert.equal(record.operator_id, operator);
  assert.equal(record.kind, "diagnostic");
  assert.equal(record.open_reason, "Find why the cabinet failed");
  assert.equal(record.last_seen_at.getTime(), record.opened_at.getTime());
  assert.equal(record.closed_at, null);
  assert.deepEqual((await entries(id)).map(e => e.action), ["session.open"]);
  assert.equal(await db!.app.transaction(tx => closeSessionRecord(tx, id, "explicit", "Investigation complete", actor)), true);
  assert.equal(await db!.app.transaction(tx => closeSessionRecord(tx, id, "killed", "Late competing close", actor)), false);
  const closed = (await sessionRecord(db!.app, id))!;
  assert.ok(closed.closed_at! >= closed.last_seen_at);
  assert.equal(closed.end_kind, "explicit");
  assert.equal(closed.close_reason, "Investigation complete");
  assert.deepEqual((await entries(id)).map(e => [e.action, e.details.reason]), [
    ["session.open", "Find why the cabinet failed"], ["session.end", "Investigation complete"],
  ]);
  const killed = await open("Check the replacement");
  await db!.app.transaction(tx => closeSessionRecord(tx, killed, "killed", "Operator revoked access", actor));
  assert.equal((await sessionRecord(db!.app, killed))!.end_kind, "killed");
  assert.deepEqual((await entries(killed)).map(e => e.action), ["session.open", "session.kill"]);
  await assert.rejects(db!.app.query("DELETE FROM remote_sessions WHERE id = $1", [id]));
  assert.ok(await sessionRecord(db!.app, id), "application role cannot erase history");
  assert.equal((await verifyAuditChain(db!.app)).ok, true);
});

test("record and audit roll back together, while a separately recorded refusal survives", async () => {
  let id = "";
  await assert.rejects(db!.app.transaction(async tx => {
    id = await insertSessionRecord(tx, { cabinetId: cabinet, operatorId: operator, kind: "diagnostic", reason: "Rolled back open" });
    throw new Error("abort open");
  }), /abort open/);
  assert.equal(await sessionRecord(db!.app, id), null);
  assert.deepEqual(await entries(id), []);
  await recordSessionRefusal(db!.app, actor, cabinet, "step_up_required", id);
  assert.deepEqual((await entries(id)).map(e => [e.action, e.details.reason]), [["session.refused", "step_up_required"]]);
  const live = await open("Rollback close check");
  await assert.rejects(db!.app.transaction(async tx => {
    await closeSessionRecord(tx, live, "error", "Rolled back close", actor);
    throw new Error("abort close");
  }), /abort close/);
  assert.equal((await sessionRecord(db!.app, live))!.closed_at, null);
  assert.deepEqual((await entries(live)).map(e => e.action), ["session.open"]);
  await db!.app.transaction(tx => closeSessionRecord(tx, live, "error", "Transport failed", actor));
});

test("the real table refuses concurrent live records and racing closes keep one reason", async () => {
  const results = await Promise.allSettled([open("First contender"), open("Second contender")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  const id = results.find(r => r.status === "fulfilled")!.value;
  const closes = await Promise.all(["First close", "Second close"].map(reason =>
    db!.app.transaction(tx => closeSessionRecord(tx, id, "explicit", reason, actor))));
  assert.equal(closes.filter(Boolean).length, 1);
  const history = await entries(id);
  assert.equal(history.length, 2);
  assert.equal((await sessionRecord(db!.app, id))!.close_reason, history[1]!.details.reason);
});

test("lifecycle closes commit before releasing buffers, and closed records reject subsequent frames", async () => {
  let lifecycle: SessionLifecycle;
  const relay = new SessionRelay((c, s, active) => lifecycle.authorize(c, s, active));
  lifecycle = new SessionLifecycle(db!.app, (c, s) => relay.close(c, s));
  const id = await open("Test live transport lifecycle");
  assert.equal(await lifecycle.authorize(randomUUID(), id), false);
  await relay.exchange(cabinet, id, "agent", Buffer.from("buffered private bytes"));
  assert.equal(await lifecycle.end(id, "killed", "Operator ended access", actor), true);
  assert.equal(await relay.exchange(cabinet, id, "agent", Buffer.alloc(0)), null);
  assert.equal(await lifecycle.end(id, "explicit", "Repeated end", actor), false);
  assert.deepEqual((await entries(id)).map(e => e.action), ["session.open", "session.kill"]);
});

test("idle expiry closes without a frame; fresh activity cannot bypass the absolute lifetime", async () => {
  const released: string[] = [];
  const lifecycle = new SessionLifecycle(db!.app, (_c, s) => released.push(s));
  const idle = await open("Idle expiry check");
  await db!.app.query(`UPDATE remote_sessions SET opened_at = DATEADD(millisecond, -$2, SYSUTCDATETIME()),
    last_seen_at = DATEADD(millisecond, -$2, SYSUTCDATETIME()) WHERE id = $1`, [idle, SESSION_IDLE_MS + 1000]);
  assert.equal(await lifecycle.expire(), 1);
  assert.equal((await sessionRecord(db!.app, idle))!.end_kind, "idle");
  assert.equal(await lifecycle.expire(), 0);
  const maximum = await open("Absolute lifetime check");
  await db!.app.query("UPDATE remote_sessions SET opened_at = DATEADD(millisecond, -$2, SYSUTCDATETIME()) WHERE id = $1", [maximum, SESSION_MAX_MS + 1000]);
  assert.equal(await lifecycle.authorize(cabinet, maximum), false);
  assert.equal((await sessionRecord(db!.app, maximum))!.close_reason, "Maximum session length reached");
  assert.deepEqual((await entries(maximum)).map(e => e.action), ["session.open", "session.kill"]);
  assert.ok(released.includes(idle));
  assert.ok(released.includes(maximum));
  assert.equal((await verifyAuditChain(db!.app)).ok, true);
});

test("operator transitions enforce ownership and agent refusal closes durably without repeating its audits", async () => {
  const released: string[] = [];
  const lifecycle = new SessionLifecycle(db!.app, (_c, s) => released.push(s));
  const id = await open("Console transition integration");
  await assert.rejects(lifecycle.endByOperator(id, randomUUID(), "killed", "Not the owner"), /no such session/);
  assert.equal((await sessionRecord(db!.app, id))!.closed_at, null);
  assert.deepEqual(await entries(id).then(rows => rows.map(r => r.action)), ["session.open"]);
  assert.deepEqual(released, []);
  assert.equal(await lifecycle.endByOperator(id, operator, "explicit", "Operator finished"), true);
  assert.equal(await lifecycle.endByOperator(id, operator, "killed", "Repeated stop"), false);
  assert.equal((await sessionRecord(db!.app, id))!.close_reason, "Operator finished");
  assert.deepEqual(await entries(id).then(rows => rows.map(r => r.action)), ["session.open", "session.end"]);

  const refused = await open("Local policy refusal");
  await assert.rejects(db!.app.transaction(tx => refuseAgentSession(tx, randomUUID(), refused, "Wrong cabinet")), /no such session/);
  await assert.rejects(db!.app.transaction(async tx => {
    await refuseAgentSession(tx, cabinet, refused, "Rolled back refusal");
    throw new Error("abort refusal");
  }), /abort refusal/);
  assert.equal((await sessionRecord(db!.app, refused))!.closed_at, null);
  assert.deepEqual(await entries(refused).then(rows => rows.map(r => r.action)), ["session.open"]);
  assert.equal(await db!.app.transaction(tx => refuseAgentSession(tx, cabinet, refused, "Local policy forbids sessions")), true);
  assert.equal(await db!.app.transaction(tx => refuseAgentSession(tx, cabinet, refused, "Repeated refusal")), false);
  assert.equal((await sessionRecord(db!.app, refused))!.end_kind, "error");
  assert.deepEqual(await entries(refused).then(rows => rows.map(r => r.action)), ["session.open", "session.refused", "session.end"]);
  assert.equal((await verifyAuditChain(db!.app)).ok, true);
});

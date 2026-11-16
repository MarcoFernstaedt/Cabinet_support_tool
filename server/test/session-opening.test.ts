import test from "node:test";
import assert from "node:assert/strict";
import { openSession, SESSION_FLEET_CAP } from "../src/services/session-opening.js";
import type { Pool, Tx } from "../src/db/db.js";

function fixture() {
  const calls: string[] = [];
  const state = { grant: true, token: true, live: [] as { cabinet_id: string }[] };
  const tx = { query: async (sql: string, params: unknown[]) => {
    calls.push(sql);
    if (sql.includes("FROM user_permissions")) return { rows: state.grant ? [{}] : [], rowCount: 0 };
    if (sql.startsWith("UPDATE step_up_tokens")) return { rows: [], rowCount: state.token ? 1 : 0 };
    if (sql.startsWith("SELECT cabinet_id FROM remote_sessions")) { assert.match(sql, /UPDLOCK, HOLDLOCK/); return { rows: state.live, rowCount: state.live.length }; }
    if (sql.includes("SELECT cl.write_paused")) return { rows: [{ write_paused: false, read_only: false, demo: 0 }], rowCount: 1 };
    if (sql.includes("SELECT writes_paused, write_limit")) return { rows: [{ writes_paused: false, write_limit: 100, writes_resumed_at: null }], rowCount: 1 };
    if (sql.includes("FROM platform_settings")) return { rows: [{ writes_paused: false }], rowCount: 1 };
    if (sql.includes("COUNT(")) return { rows: [{ n: 0, count: 0 }], rowCount: 1 };
    if (sql.includes("EXEC audit_append")) {
      assert.ok(params.includes("session.open") || params.includes("session.refused"));
      return { rows: [{ seq: "1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  } } as unknown as Tx;
  const pool = { query: tx.query, transaction: async (fn: (tx: Tx) => Promise<unknown>) => fn(tx) } as unknown as Pool;
  return { state, calls, pool };
}
const input = { kind: "diagnostic" as const, reason: "Find the failure", stepUpToken: "token" };
test("session admission checks grant before consuming step-up, then writes record, audit and command", async () => {
  const f = fixture();
  f.state.grant = false;
  await assert.rejects(openSession(f.pool, "operator", "cabinet", input), /matching permission/);
  assert.ok(!f.calls.some(sql => sql.startsWith("UPDATE step_up_tokens")));
  f.state.grant = true; f.state.token = false; f.calls.length = 0;
  await assert.rejects(openSession(f.pool, "operator", "cabinet", input), /valid step-up/);
  assert.ok(!f.calls.some(sql => sql.startsWith("INSERT INTO remote_sessions")));
});
test("same cabinet and fleet capacity refuse before creating another session", async () => {
  for (const live of [[{ cabinet_id: "cabinet" }], Array.from({ length: SESSION_FLEET_CAP }, (_, n) => ({ cabinet_id: String(n) }))]) {
    const f = fixture(); f.state.live = live;
    await assert.rejects(openSession(f.pool, "operator", "cabinet", input), /already live|fleet limit/);
    assert.ok(!f.calls.some(sql => sql.startsWith("INSERT INTO remote_sessions")));
  }
});

test("successful admission queues only the server-generated session ID", async () => {
  const f = fixture();
  const opened = await openSession(f.pool, "operator", "cabinet", input);
  assert.match(opened.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(f.calls.filter(sql => sql.startsWith("INSERT INTO remote_sessions")).length, 1);
  assert.equal(f.calls.filter(sql => sql.startsWith("INSERT INTO commands")).length, 1);
});

test("shell admission without an agent capability report refuses and audits without queuing a command", async () => {
  const f = fixture();
  await assert.rejects(openSession(f.pool, "operator", "cabinet", { ...input, kind: "shell" }), /not reported/);
  assert.ok(!f.calls.some(sql => sql.startsWith("INSERT INTO commands")));
  assert.ok(f.calls.some(sql => sql.includes("EXEC audit_append")));
});

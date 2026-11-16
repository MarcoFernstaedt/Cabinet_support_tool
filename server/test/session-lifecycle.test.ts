import test from "node:test";
import assert from "node:assert/strict";
import { SessionLifecycle, sessionExpiry, SESSION_IDLE_MS, SESSION_MAX_MS } from "../src/services/session-lifecycle.js";
import type { Pool, Tx } from "../src/db/db.js";

test("idle and absolute deadlines are inclusive and frames cannot extend the absolute deadline", () => {
  const opened = new Date(0);
  assert.equal(sessionExpiry(opened, opened, new Date(SESSION_IDLE_MS - 1)), null);
  assert.deepEqual(sessionExpiry(opened, opened, new Date(SESSION_IDLE_MS)), { end: "idle", reason: "Session idle timeout" });
  assert.deepEqual(sessionExpiry(opened, new Date(SESSION_MAX_MS - 1), new Date(SESSION_MAX_MS)),
    { end: "killed", reason: "Maximum session length reached" });
  assert.deepEqual(sessionExpiry(opened, opened, new Date(SESSION_MAX_MS)),
    { end: "killed", reason: "Maximum session length reached" });
});

test("failed close commit never releases buffers, successful close releases only after commit", async () => {
  let committed = false, failCommit = true;
  const tx = { query: async (sql: string) => {
    if (sql.startsWith("SELECT")) return { rows: [{ cabinet_id: "cabinet" }], rowCount: 1 };
    if (sql.startsWith("UPDATE")) return { rows: [{ cabinet_id: "cabinet" }], rowCount: 1 };
    return { rows: [{ seq: "1" }], rowCount: 1 };
  } } as unknown as Tx;
  const pool = { transaction: async (fn: (c: Tx) => Promise<unknown>) => {
    const result = await fn(tx);
    if (failCommit) throw new Error("commit failed");
    committed = true;
    return result;
  } } as unknown as Pool;
  const releases: string[] = [];
  const lifecycle = new SessionLifecycle(pool, (c, s) => {
    assert.equal(committed, true);
    releases.push(`${c}/${s}`);
  });
  const actor = { actorKind: "user" as const, actorId: "operator" };
  await assert.rejects(lifecycle.end("session", "explicit", "Finished diagnosis", actor), /commit failed/);
  assert.deepEqual(releases, []);
  failCommit = false;
  assert.equal(await lifecycle.end("session", "explicit", "Finished diagnosis", actor), true);
  assert.deepEqual(releases, ["cabinet/session"]);
});

test("authorization refuses missing, mismatched and closed records without refreshing activity", async () => {
  for (const row of [null, { cabinet_id: "other" }, { cabinet_id: "cabinet", closed_at: new Date() }]) {
    let released = false;
    const tx = { query: async (sql: string) => {
      assert.ok(sql.startsWith("SELECT"), "refused records must never be touched");
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    } } as unknown as Tx;
    const pool = { transaction: (fn: (c: Tx) => Promise<unknown>) => fn(tx) } as unknown as Pool;
    const lifecycle = new SessionLifecycle(pool, () => { released = true; });
    assert.equal(await lifecycle.authorize("cabinet", "session"), false);
    assert.equal(released, true);
  }
});

test("operator termination checks ownership under the close lock and releases only after commit", async () => {
  let owner = "other", committed = false, writes = 0;
  const tx = { query: async (sql: string) => {
    if (sql.startsWith("SELECT")) return { rows: [{ cabinet_id: "cabinet", operator_id: owner }], rowCount: 1 };
    writes++;
    return { rows: [{ cabinet_id: "cabinet", seq: "1" }], rowCount: 1 };
  } } as unknown as Tx;
  const pool = { transaction: async (fn: (c: Tx) => Promise<unknown>) => {
    const result = await fn(tx); committed = true; return result;
  } } as unknown as Pool;
  let released = 0;
  const lifecycle = new SessionLifecycle(pool, () => { assert.equal(committed, true); released++; });
  await assert.rejects(lifecycle.endByOperator("session", "operator", "explicit", "Done"), /no such session/);
  assert.equal(writes, 0);
  assert.equal(released, 0);
  owner = "operator";
  assert.equal(await lifecycle.endByOperator("session", "operator", "killed", "Stop access"), true);
  assert.equal(writes, 3, "close, audit and committed notification");
  assert.equal(released, 1);
});

test("revoking the opening operator's last grant kills the record without touching activity", async () => {
  let committed = false, touched = false;
  const actions: unknown[] = [];
  const tx = { query: async (sql: string, params: unknown[]) => {
    if (sql.startsWith("SELECT *,")) return { rows: [{ cabinet_id: "cabinet", operator_id: "operator", closed_at: null,
      opened_at: new Date(), last_seen_at: new Date(), now: new Date() }], rowCount: 1 };
    if (sql.includes("FROM user_permissions")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("UPDATE remote_sessions SET last_seen_at")) touched = true;
    if (sql.startsWith("UPDATE remote_sessions SET closed_at")) {
      assert.deepEqual(params, ["session", "killed", "Opening operator permission revoked"]);
      return { rows: [{ cabinet_id: "cabinet" }], rowCount: 1 };
    }
    if (sql.includes("EXEC audit_append")) { actions.push(params[2]); return { rows: [{ seq: "1" }], rowCount: 1 }; }
    return { rows: [], rowCount: 1 };
  } } as unknown as Tx;
  const pool = { transaction: async (fn: (c: Tx) => Promise<unknown>) => { const result = await fn(tx); committed = true; return result; } } as unknown as Pool;
  let released = false;
  const lifecycle = new SessionLifecycle(pool, () => { assert.equal(committed, true); released = true; });
  assert.equal(await lifecycle.authorize("cabinet", "session"), false);
  assert.equal(touched, false);
  assert.equal(released, true);
  assert.deepEqual(actions, ["session.kill"]);
});

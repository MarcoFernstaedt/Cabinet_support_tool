import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { sessionRoutes } from "../src/console-api/session-routes.js";
import type { ConsoleApiOptions, Guards } from "../src/console-api/server.js";
import type { SessionLifecycle } from "../src/services/session-lifecycle.js";
import type { Pool, Tx } from "../src/db/db.js";
import { storeResult } from "../src/services/commands.js";
import type { Result } from "../src/contracts.js";
import { ContractError } from "../src/contracts.js";
import { Refused } from "../src/services/errors.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

test("console termination requires complete sign-in, validates the reason and forwards the authenticated identity", async () => {
  const calls: unknown[][] = [];
  let stage = "totp";
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Refused) return reply.code(error.status).send({ error: error.code });
    if (error instanceof ContractError) return reply.code(400).send({ error: "invalid_body" });
    return reply.code(500).send({ error: "internal_error" });
  });
  await app.register(sessionRoutes, {
    guards: { session: async () => ({ userId: "operator", stage }) } as unknown as Guards,
    sessionLifecycle: { endByOperator: async (...args: unknown[]) => { calls.push(args); return true; } } as unknown as SessionLifecycle,
  } as ConsoleApiOptions & { guards: Guards });
  try {
    assert.equal((await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/end`, payload: { reason: "Done" } })).statusCode, 401);
    stage = "complete";
    for (const payload of [{}, { reason: " " }, { reason: "x".repeat(1001) }, { reason: "Done", operatorId: "other" }]) {
      const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/end`, payload });
      assert.equal(response.statusCode, 400);
    }
    assert.deepEqual(calls, []);
    for (const action of ["end", "kill"]) {
      const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/${action}`, payload: { reason: "Done" } });
      assert.equal(response.statusCode, 200);
    }
    assert.deepEqual(calls, [[sessionId, "operator", "explicit", "Done"], [sessionId, "operator", "killed", "Done"]]);
  } finally { await app.close(); }
});

test("a failed agent open uses the stored command's session ID and records refusal and close in the result transaction", async () => {
  const actions: string[] = [];
  let closed = false;
  const tx = { query: async (sql: string, params: unknown[]) => {
    if (sql.startsWith("SELECT operation")) return { rows: [{ operation: "session.open", status: "delivered", delivered: 1, params: { sessionId } }], rowCount: 1 };
    if (sql.startsWith("SELECT *,")) {
      assert.equal(params[0], sessionId);
      return { rows: [{ cabinet_id: "cabinet", closed_at: null }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE remote_sessions")) { closed = true; return { rows: [{ cabinet_id: "cabinet" }], rowCount: 1 }; }
    if (sql.includes("EXEC audit_append ")) actions.push(params[2] as string);
    return { rows: [{ seq: "1" }], rowCount: 1 };
  } } as unknown as Tx;
  let committed = false;
  const pool = { transaction: async (fn: (c: Tx) => Promise<unknown>) => { await fn(tx); committed = true; } } as unknown as Pool;
  await storeResult(pool, "cabinet", { commandId: "command", status: "rejected", error: { code: "policy_off", message: "private agent text" },
    output: { sessionId: "attacker-selected" }, finishedAt: new Date().toISOString() } as unknown as Result);
  assert.equal(committed, true);
  assert.equal(closed, true);
  assert.deepEqual(actions, ["session.refused", "session.end", "command.result"]);
});

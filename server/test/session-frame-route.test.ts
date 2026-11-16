import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerSessionFrameRoute } from "../src/agent-api/session-frame-route.js";
import { SessionRelay } from "../src/agent-api/session-relay.js";
import { ContractError } from "../src/contracts.js";
import { SessionLifecycle } from "../src/services/session-lifecycle.js";
import type { Pool, Tx } from "../src/db/db.js";

const id = "11111111-1111-4111-8111-111111111111";
function api(relay?: SessionRelay) {
  const app = Fastify();
  app.addHook("onRequest", async request => { request.cabinet = { id: "cabinet" } as NonNullable<typeof request.cabinet>; });
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ContractError ? 400 : 500).send({ error: "refused" }));
  registerSessionFrameRoute(app, relay, () => 57);
  return app;
}
test("frame route fails closed without relay or authorization, and validates UUID, null, size and base64", async () => {
  for (const relay of [undefined, new SessionRelay(async () => false)]) {
    const app = api(relay);
    try {
      for (const [session, payload] of [[id, { data: "" }], ["not-a-uuid", { data: "" }], [id, null]] as const)
        assert.equal((await app.inject({ method: "POST", url: `/agent/v1/sessions/${session}/frames`, payload: JSON.stringify(payload), headers: { "content-type": "application/json" } })).statusCode, 404);
    } finally { await app.close(); }
  }
  const app = api(new SessionRelay(async () => true));
  try {
    const send = (payload: unknown) => app.inject({ method: "POST", url: `/agent/v1/sessions/${id}/frames`, payload: JSON.stringify(payload), headers: { "content-type": "application/json" } });
    assert.equal((await send({ data: Buffer.alloc(16_385).toString("base64") })).statusCode, 413);
    assert.equal((await send({ data: "!" })).statusCode, 400);
    const boundary = await send({ data: Buffer.alloc(16_384).toString("base64") });
    assert.equal(boundary.statusCode, 200);
    assert.deepEqual(boundary.json(), { control: "keepalive" });
  } finally { await app.close(); }
});
test("route backpressure uses the supplied server backoff instead of a constant retry hint", async () => {
  const relay = new SessionRelay(async () => true), app = api(relay);
  try {
    for (let i = 0; i < 16; i++) await relay.exchange("cabinet", id, "agent", Buffer.from("output"));
    const response = await app.inject({ method: "POST", url: `/agent/v1/sessions/${id}/frames`, payload: { data: "YQ==" } });
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers["retry-after"], "57");
    assert.equal(response.json().error, "relay_backpressure");
  } finally { await app.close(); }
});
test("route fleet queue capacity returns 503 with the server backoff", async () => {
  const relay = new SessionRelay(async () => true), app = api(relay);
  try {
    for (let i = 0; i < 16; i++) await relay.exchange("cabinet", String(i), "agent", Buffer.alloc(0));
    const response = await app.inject({ method: "POST", url: `/agent/v1/sessions/${id}/frames`, payload: { data: "" } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["retry-after"], "57");
    assert.equal(response.json().error, "relay_capacity");
  } finally { await app.close(); }
});

test("composed route, relay and lifecycle touch live records and destroy output after durable close", async () => {
  let closed = false, touches = 0;
  const tx = { query: async (sql: string) => {
    if (sql.startsWith("SELECT *,")) {
      assert.match(sql, /WITH \(UPDLOCK, HOLDLOCK\)/);
      return { rows: [{ cabinet_id: "cabinet", closed_at: closed ? new Date() : null, opened_at: new Date(), last_seen_at: new Date(), now: new Date() }], rowCount: 1 };
    }
    if (sql.includes("FROM user_permissions")) return { rows: [{}], rowCount: 1 };
    if (sql.startsWith("UPDATE remote_sessions SET last_seen_at")) touches++;
    return { rows: [], rowCount: 1 };
  } } as unknown as Tx;
  const pool = { transaction: async (fn: (c: Tx) => Promise<unknown>) => fn(tx) } as unknown as Pool;
  let lifecycle: SessionLifecycle;
  const relay = new SessionRelay((c, s, active) => lifecycle.authorize(c, s, active));
  lifecycle = new SessionLifecycle(pool, (c, s) => relay.close(c, s));
  const app = api(relay);
  try {
    const send = () => app.inject({ method: "POST", url: `/agent/v1/sessions/${id}/frames`, payload: { data: "YQ==" } });
    assert.equal((await send()).statusCode, 200);
    assert.equal(touches, 1);
    const poll = await app.inject({ method: "POST", url: `/agent/v1/sessions/${id}/frames`, payload: { data: "" } });
    assert.equal(poll.statusCode, 200);
    assert.equal(touches, 1, "empty agent keepalive polls cannot defeat idle expiry");
    closed = true;
    assert.equal((await send()).statusCode, 404);
    closed = false; // test-only restoration proves the queue was actually destroyed.
    assert.deepEqual(await relay.exchange("cabinet", id, "console", Buffer.alloc(0)), Buffer.alloc(0));
  } finally { await app.close(); }
});

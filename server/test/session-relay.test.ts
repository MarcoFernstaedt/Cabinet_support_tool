import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRelay } from "../src/agent-api/session-relay.js";
import { envelopes } from "../src/contracts.js";

test("relay transports opaque bytes in both directions and isolates cabinets", async () => {
  const relay = new SessionRelay(async (cabinet, session) => cabinet === "cabinet" && session === "session");
  const bytes = Buffer.from("not.a.catalog.operation\0powershell.exe", "utf8");
  assert.deepEqual(await relay.exchange("cabinet", "session", "console", bytes), Buffer.alloc(0));
  assert.equal(await relay.exchange("other", "session", "agent", Buffer.alloc(0)), null);
  assert.deepEqual(await relay.exchange("cabinet", "session", "agent", Buffer.from([0, 255])), bytes);
  assert.deepEqual(await relay.exchange("cabinet", "session", "console", Buffer.alloc(0)), Buffer.from([0, 255]));
});

test("revocation discards buffered frames and close releases capacity", async () => {
  let allowed = true;
  const relay = new SessionRelay(async () => allowed);
  await relay.exchange("c", "s", "console", Buffer.from("private"));
  allowed = false;
  assert.equal(await relay.exchange("c", "s", "agent", Buffer.alloc(0)), null);
  allowed = true;
  assert.deepEqual(await relay.exchange("c", "s", "agent", Buffer.alloc(0)), Buffer.alloc(0));
  for (let i = 0; i < 15; i++) await relay.exchange("c", String(i), "agent", Buffer.alloc(0));
  await assert.rejects(relay.exchange("c", "overflow", "agent", Buffer.alloc(0)), /relay_capacity/);
  relay.close("c", "s");
  assert.deepEqual(await relay.exchange("c", "overflow", "agent", Buffer.alloc(0)), Buffer.alloc(0));
});

test("relay bounds frames and queues without overwriting", async () => {
  const relay = new SessionRelay(async () => true);
  await assert.rejects(relay.exchange("c", "s", "agent", Buffer.alloc(16_385)), /relay_frame_too_large/);
  for (let i = 0; i < 16; i++) await relay.exchange("c", "s", "agent", Buffer.from([i]));
  await assert.rejects(relay.exchange("c", "s", "agent", Buffer.from([99])), /relay_backpressure/);
  for (let i = 0; i < 16; i++) assert.deepEqual(await relay.exchange("c", "s", "console", Buffer.alloc(0)), Buffer.from([i]));
});

test("frame contract refuses executable metadata and malformed base64", () => {
  assert.deepEqual(envelopes.sessionFrame.parse({ data: "AP8=" }), { data: "AP8=" });
  envelopes.sessionFrame.parse({ data: Buffer.alloc(16_384).toString("base64") });
  assert.throws(() => envelopes.sessionFrame.parse({ data: Buffer.alloc(16_385).toString("base64") }));
  for (const frame of [{ data: "!" }, { data: "AAAA", operation: "shell" }, { data: "A" }, { data: "A".repeat(21852) }])
    assert.throws(() => envelopes.sessionFrame.parse(frame));
});

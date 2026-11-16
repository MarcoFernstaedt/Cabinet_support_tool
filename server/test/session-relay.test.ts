import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRelay } from "../src/agent-api/session-relay.js";
import { envelopes } from "../src/contracts.js";

test("only diagnostic output goes to console; agent receives fixed controls and cabinets stay isolated", async () => {
  const relay = new SessionRelay(async (cabinet, session) => cabinet === "cabinet" && session === "session");
  const bytes = Buffer.from("not.a.catalog.operation\0powershell.exe", "utf8");
  await assert.rejects(relay.exchange("cabinet", "session", "console", bytes), /relay_control_required/);
  await relay.control("cabinet", "session", "open");
  assert.equal(await relay.exchange("other", "session", "agent", Buffer.alloc(0)), null);
  assert.deepEqual(JSON.parse((await relay.exchange("cabinet", "session", "agent", bytes))!.toString()), { control: "open" });
  assert.deepEqual(await relay.exchange("cabinet", "session", "console", Buffer.alloc(0)), bytes);
  await assert.rejects(relay.control("cabinet", "session", "shell" as "open"), /relay_control_required/);
});

test("revocation discards buffered frames and close releases capacity", async () => {
  let allowed = true;
  const relay = new SessionRelay(async () => allowed);
  await relay.exchange("c", "s", "agent", Buffer.from("private"));
  allowed = false;
  assert.equal(await relay.exchange("c", "s", "agent", Buffer.alloc(0)), null);
  allowed = true;
  assert.deepEqual(await relay.exchange("c", "s", "console", Buffer.alloc(0)), Buffer.alloc(0));
  for (let i = 0; i < 15; i++) await relay.exchange("c", String(i), "agent", Buffer.alloc(0));
  await assert.rejects(relay.exchange("c", "overflow", "agent", Buffer.alloc(0)), /relay_capacity/);
  relay.close("c", "s");
  assert.deepEqual(JSON.parse((await relay.exchange("c", "overflow", "agent", Buffer.alloc(0)))!.toString()), { control: "keepalive" });
});

test("relay bounds frames and queues without overwriting", async () => {
  const relay = new SessionRelay(async () => true);
  assert.equal(SessionRelay.maxFrameBytes, 16_384);
  await relay.exchange("c", "boundary", "agent", Buffer.alloc(16_384));
  await assert.rejects(relay.exchange("c", "s", "agent", Buffer.alloc(16_385)), /relay_frame_too_large/);
  for (let i = 0; i < 16; i++) await relay.exchange("c", "s", "agent", Buffer.from([i]));
  await assert.rejects(relay.exchange("c", "s", "agent", Buffer.from([99])), /relay_backpressure/);
  for (let i = 0; i < 16; i++) assert.deepEqual(await relay.exchange("c", "s", "console", Buffer.alloc(0)), Buffer.from([i]));
  for (let i = 0; i < 16; i++) await relay.control("c", "s", i % 2 ? "close" : "open");
  await assert.rejects(relay.control("c", "s", "keepalive"), /relay_backpressure/);
  for (let i = 0; i < 16; i++)
    assert.deepEqual(JSON.parse((await relay.exchange("c", "s", "agent", Buffer.alloc(0)))!.toString()), { control: i % 2 ? "close" : "open" });
});

test("frame contract refuses executable metadata and malformed base64", () => {
  assert.deepEqual(envelopes.sessionFrame.parse({ data: "AP8=" }), { data: "AP8=" });
  envelopes.sessionFrame.parse({ data: Buffer.alloc(16_384).toString("base64") });
  assert.throws(() => envelopes.sessionFrame.parse({ data: Buffer.alloc(16_385).toString("base64") }));
  for (const frame of [{ data: "!" }, { data: "AAAA", operation: "shell" }, { data: "A" }, { data: "A".repeat(21852) }])
    assert.throws(() => envelopes.sessionFrame.parse(frame));
});

test("throwing authorization destroys buffered output before propagating the error", async () => {
  let broken = false;
  const relay = new SessionRelay(async () => { if (broken) throw new Error("database unavailable"); return true; });
  await relay.exchange("c", "s", "agent", Buffer.from("private"));
  await relay.control("c", "s", "open");
  broken = true;
  await assert.rejects(relay.exchange("c", "s", "console", Buffer.alloc(0)), /database unavailable/);
  broken = false;
  assert.deepEqual(await relay.exchange("c", "s", "console", Buffer.alloc(0)), Buffer.alloc(0));
  assert.deepEqual(JSON.parse((await relay.exchange("c", "s", "agent", Buffer.alloc(0)))!.toString()), { control: "keepalive" });
});

test("committed closure notifications free buffers in another agent worker", async () => {
  const relay = new SessionRelay(async () => true);
  await relay.exchange("cabinet", "session", "agent", Buffer.from("private"));
  let handler: (payload: string) => void = () => assert.fail("not subscribed");
  let removed = false;
  const stop = relay.watchClosures({ on: (channel, callback) => {
    assert.equal(channel, "sessions_closed"); handler = callback;
    return () => { removed = true; };
  } });
  handler("cabinet|session");
  assert.deepEqual(await relay.exchange("cabinet", "session", "console", Buffer.alloc(0)), Buffer.alloc(0));
  stop();
  assert.equal(removed, true);
});

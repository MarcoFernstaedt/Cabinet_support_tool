import test from "node:test";
import assert from "node:assert/strict";
import { TARGET_FILTERS, targetBadge, targetNote } from "../src/lib/rollout-target.ts";

const name = (c: string) => ({ check_in: "check-in within 5 minutes" } as Record<string, string>)[c] ?? c;

test("a skipped cabinet is called offline only when it was out of contact", () => {
  assert.deepEqual(targetBadge({ state: "skipped", outcome: "offline" }), ["off", "Skipped (offline)"]);
  assert.deepEqual(targetBadge({ state: "skipped", outcome: null }), ["off", "Skipped (not reached)"]);
  for (const outcome of ["failed", "timed_out", "", "OFFLINE"]) assert.equal(targetBadge({ state: "skipped", outcome })[1], "Skipped (not reached)", outcome);
});

test("a skipped cabinet with no outcome still shows why", () => {
  const notReached = { state: "skipped", outcome: null, check: null, message: "The rollout completed before this cabinet took the version." };
  assert.equal(targetNote(notReached, name), notReached.message);
  assert.equal(targetNote({ ...notReached, message: null }, name), null);
  assert.equal(targetNote({ state: "skipped", outcome: "offline", check: null, message: "Offline when the rollout completed: not upgraded." }, name),
    "offline: Offline when the rollout completed: not upgraded.");
});

test("the other states read as before", () => {
  assert.deepEqual(targetBadge({ state: "pending", outcome: null }), ["off", "Waiting"]);
  assert.deepEqual(targetBadge({ state: "offered", outcome: null }), ["info", "Offered"]);
  assert.deepEqual(targetBadge({ state: "succeeded", outcome: "succeeded" }), ["ok", "Upgraded"]);
  assert.deepEqual(targetBadge({ state: "failed", outcome: "timed_out" }), ["crit", "Failed"]);
  assert.deepEqual(targetBadge({ state: "constructor", outcome: null }), ["off", "constructor"], "an unknown state is shown as it is");
  assert.equal(targetNote({ state: "failed", outcome: "rolled_back", check: "check_in", message: "no heartbeat" }, name), "rolled back at the check-in within 5 minutes check: no heartbeat");
  assert.equal(targetNote({ state: "succeeded", outcome: "succeeded", check: null, message: "Running 0.3.0." }, name), null);
  assert.equal(targetNote({ state: "pending", outcome: null, check: null, message: null }, name), null);
});

test("the filter offers every state once, and calls the skipped ones Skipped, not offline", () => {
  assert.deepEqual(TARGET_FILTERS, [["pending", "Waiting"], ["offered", "Offered"], ["succeeded", "Upgraded"], ["failed", "Failed"], ["skipped", "Skipped"]]);
});

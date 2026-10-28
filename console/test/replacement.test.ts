// The approval's "Replaces" choice (src/lib/replacement.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { reapplySummary, replaceable, replacementSentence, replacesFrom, stepValue, type ReapplyStep, type SiteCabinet } from "../src/lib/replacement.ts";

const cab = (over: Partial<SiteCabinet>): SiteCabinet => ({ id: "1", name: "SYNC", role: "sync", status: "active", online: true, lastHeartbeatAt: null, ...over });

test("only active cabinets of the chosen role are offered, offline ones first", () => {
  const list = [cab({ id: "a", name: "A" }), cab({ id: "b", name: "B", online: false }), cab({ id: "c", role: "satellite" }), cab({ id: "d", status: "pending" })];
  assert.deepEqual(replaceable(list, "sync").map(c => c.id), ["b", "a"]);
  assert.deepEqual(replaceable(list, "satellite").map(c => c.id), ["c"]);
  assert.deepEqual(replaceable(list, "standalone"), []);
});

test("the id is sent only while it is still one of the choices", () => {
  const list = [cab({ id: "a" })];
  assert.deepEqual(replacesFrom("a", list), { replacesCabinetId: "a" });
  assert.deepEqual(replacesFrom("", list), {});
  assert.deepEqual(replacesFrom("a", []), {}, "a role change that leaves it out drops it");
  assert.deepEqual(replacesFrom("'; DROP", list), {});
});

test("the confirmation says what happens to the old cabinet", () => {
  const same = replacementSentence(cab({ name: "SYNC" }), " sync ");
  assert.match(same, /takes the name SYNC/);
  assert.match(same, /satellites move/);
  const other = replacementSentence(cab({ name: "EXAM 1", role: "satellite" }), "EXAM 1B");
  assert.doesNotMatch(other, /takes the name/);
  assert.match(other, /keeps the sync cabinet/);
});

test("each re-applied setting is said in words, and a step with nothing to send shows none", () => {
  const step = (kind: ReapplyStep["kind"], params: Record<string, unknown> | null): ReapplyStep => ({ kind, operation: "x", params, state: "verified", detail: null, updatedAt: "2026-10-28T10:00:00Z" });
  assert.equal(stepValue(step("firewall", { profiles: { domain: false, private: false, public: true } })), "Domain off, Private off, Public on");
  assert.equal(stepValue(step("time_zone", { timeZoneId: "Pacific Standard Time" })), "Pacific Standard Time");
  assert.equal(stepValue(step("drawer", { interfaceIndex: 4, mode: "static", address: "172.20.1.0", prefixLength: 32 })), "172.20.1.0/32, no gateway");
  assert.equal(stepValue(step("address", { interfaceIndex: 4, mode: "static", address: "10.0.0.4", prefixLength: 24, gateway: "10.0.0.1" })), "10.0.0.4/24, gateway 10.0.0.1");
  assert.equal(stepValue(step("dns", { interfaceIndex: 4, mode: "static", servers: ["10.0.0.2", "1.1.1.1"] })), "10.0.0.2, 1.1.1.1");
  assert.equal(stepValue(step("dns", null)), null);
  assert.match(reapplySummary({ state: "waiting", detail: null, queuedAt: "", finishedAt: null, steps: [] }, "FRONT"), /^Waiting for this cabinet to report/);
  assert.equal(reapplySummary({ state: "done", detail: "5 re-applied and verified; 0 not needed.", queuedAt: "", finishedAt: null, steps: [] }, "FRONT"), "5 re-applied and verified; 0 not needed.");
});

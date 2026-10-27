// The approval's "Replaces" choice (src/lib/replacement.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { replaceable, replacementSentence, replacesFrom, type SiteCabinet } from "../src/lib/replacement.ts";

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

// The sync-cabinet warning in a change's confirmation (src/lib/sync-warning.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { syncWarning } from "../src/lib/sync-warning.ts";

test("a sync cabinet with satellites names them; one with none has no warning", () => {
  assert.equal(syncWarning(0, []), null);
  assert.equal(syncWarning(1, ["EXAM 1"]), "This is the sync cabinet for 1 satellite (EXAM 1). If this change takes it offline, that satellite loses sync until it is back.");
  assert.equal(syncWarning(2, ["EXAM 1", "EXAM 2"]), "This is the sync cabinet for 2 satellites (EXAM 1, EXAM 2). If this change takes it offline, they lose sync until it is back.");
});

test("more satellites than names shown are counted, not dropped", () => {
  const names = Array.from({ length: 10 }, (_, i) => `SAT ${i + 1}`);
  assert.match(syncWarning(14, names)!, /\(SAT 1, .*SAT 10 and 4 more\)/);
  assert.match(syncWarning(3, [])!, /^This is the sync cabinet for 3 satellites\. /, "no names from an older server: the count alone");
});

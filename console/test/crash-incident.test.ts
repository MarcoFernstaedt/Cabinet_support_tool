import test from "node:test";
import assert from "node:assert/strict";
import { incidentBadge, timesText, totalCrashes } from "../src/lib/crash-incident.ts";

test("an alert is shown once with how many times it happened", () => {
  assert.equal(timesText(1), "Once");
  assert.equal(timesText(15), "15 times");
  assert.equal(timesText(1200), "1,200 times");
  for (const bad of [0, -3, 1.5, Number.NaN, null, "15"]) assert.equal(timesText(bad), "—", String(bad));
});

test("the incident's total counts each crash once, and ignores nonsense counts", () => {
  assert.equal(totalCrashes([{ occurrences: 15 }, { occurrences: 3 }]), 18);
  assert.equal(totalCrashes([{ occurrences: -1 }, { occurrences: 2.5 }, { occurrences: 4 }]), 4);
  assert.equal(totalCrashes([]), 0);
});

test("the incident's state reads plainly", () => {
  assert.equal(incidentBadge("open")[0], "crit");
  assert.equal(incidentBadge("resolved")[0], "ok");
  assert.deepEqual(incidentBadge("<x>"), ["off", "Unknown"]);
});

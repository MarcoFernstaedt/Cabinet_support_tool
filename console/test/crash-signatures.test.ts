import test from "node:test";
import assert from "node:assert/strict";
import { trendText } from "../src/lib/crash-signatures.ts";

test("the trend says whether a kind of blue screen is growing, shrinking or new", () => {
  assert.equal(trendText({ lastDay: 9, dayBefore: 2 }), "9 in the last day, up from 2");
  assert.equal(trendText({ lastDay: 1, dayBefore: 4 }), "1 in the last day, down from 4");
  assert.equal(trendText({ lastDay: 3, dayBefore: 0 }), "3 in the last day, none the day before");
  assert.equal(trendText({ lastDay: 0, dayBefore: 5 }), "none in the last day, down from 5");
  assert.equal(trendText({ lastDay: 0, dayBefore: 0 }), "none in the last two days");
  assert.equal(trendText({ lastDay: 2, dayBefore: 2 }), "2 in the last day, the same as the day before");
});

test("counts that are not whole and non-negative read as unknown, never as a trend", () => {
  for (const r of [{ lastDay: -1, dayBefore: 0 }, { lastDay: 1.5, dayBefore: 0 }, { lastDay: NaN, dayBefore: 1 }, { lastDay: 1, dayBefore: Infinity }])
    assert.equal(trendText(r), "unknown", JSON.stringify(r));
});

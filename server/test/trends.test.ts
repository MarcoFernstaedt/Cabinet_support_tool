// The trend arithmetic with plain numbers: the slope and how long until a limit or until empty (disk-forecast.ts uses them).
import test from "node:test";
import assert from "node:assert/strict";
import { daysUntil, daysUntilEmpty, slopePerDay } from "../src/services/trends.js";

const DAY = 86_400_000, T0 = Date.UTC(2026, 0, 1);

test("slope is per day, needs enough points over enough time, and ignores nothing silently", () => {
  const rising = Array.from({ length: 10 }, (_, d) => ({ t: T0 + d * DAY, v: 5 + 2 * d }));
  assert.ok(Math.abs(slopePerDay(rising)! - 2) < 1e-9);
  assert.equal(slopePerDay(rising.slice(0, 3)), null, "three points are not a trend");
  assert.equal(slopePerDay(Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * 60_000, v: i }))), null, "ten minutes is not a trend");
  assert.equal(slopePerDay([{ t: T0, v: 1 }, { t: T0, v: 2 }, { t: T0, v: 3 }, { t: T0, v: 4 }]), null, "no time at all");
  assert.ok(Math.abs(slopePerDay(rising.map(p => ({ ...p, v: 100 - p.v })))! + 2) < 1e-9);
});

test("days until a limit or until empty", () => {
  assert.equal(daysUntil(100, 90, 2), 5);
  assert.equal(daysUntil(100, 90, 0), null);
  assert.equal(daysUntil(100, 90, -1), null);
  assert.equal(daysUntil(100, 100, null), 0);
  assert.equal(daysUntilEmpty(30, -3), 10);
  assert.equal(daysUntilEmpty(30, 3), null);
  assert.equal(daysUntilEmpty(0, null), 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { causesLine } from "../src/lib/shutdown-causes.ts";

test("the restarts are split by cause, leaving out causes with none", () => {
  assert.equal(causesLine({ bugCheck: 2, forcedOff: 1, powerLossOrHang: 1 }), "2 after a blue screen · 1 the power button was held · 1 power lost or Windows froze");
  assert.equal(causesLine({ bugCheck: 0, forcedOff: 0, powerLossOrHang: 3 }), "3 power lost or Windows froze");
});

test("nothing to say, or values that are not counts, never print a broken line", () => {
  assert.equal(causesLine({ bugCheck: 0, forcedOff: 0, powerLossOrHang: 0 }), null);
  assert.equal(causesLine(null), null);
  assert.equal(causesLine(undefined), null, "a server from before this change sends no causes");
  assert.equal(causesLine({ bugCheck: Number.NaN, forcedOff: -1, powerLossOrHang: "2" as never }), null);
});

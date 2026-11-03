import test from "node:test";
import assert from "node:assert/strict";
import { durationText, endText } from "../src/lib/boot-history.ts";

test("how the run before a start ended reads as words", () => {
  assert.equal(endText({ previous: "clean", cause: null, reason: null }), "Shut down normally");
  assert.equal(endText({ previous: "requested", cause: null, reason: "TrustedInstaller.exe restarted it" }), "Restart requested: TrustedInstaller.exe restarted it");
  assert.equal(endText({ previous: "requested", cause: null, reason: null }), "Restart requested");
  assert.equal(endText({ previous: "unexpected", cause: "bug_check", reason: null }), "Did not shut down: a blue screen");
  assert.equal(endText({ previous: "unexpected", cause: "forced_off", reason: null }), "Did not shut down: the power button was held");
  assert.equal(endText({ previous: "unexpected", cause: null, reason: null }), "Did not shut down: cause not known");
  assert.equal(endText({ previous: "unknown", cause: null, reason: null }), "Not in the log");
  assert.equal(endText({ previous: "rebooted_by_aliens" as never, cause: null, reason: null }), "rebooted_by_aliens", "a value from a newer agent is shown, not hidden");
});

test("run lengths are readable, and a missing or broken one is a dash", () => {
  assert.equal(durationText(59), "0 min");
  assert.equal(durationText(3 * 3600 + 25 * 60), "3 h 25 min");
  assert.equal(durationText(7 * 86_400 - 40), "6 d 23 h");
  for (const bad of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(durationText(bad), "—", String(bad));
});

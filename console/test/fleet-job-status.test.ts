import test from "node:test";
import assert from "node:assert/strict";
import { jobPhase, keepFollowing, phaseText, stillSent } from "../src/lib/fleet-job-status.ts";

const at = "2026-11-14T20:00:00Z";

test("a cancelled job is cancelling until it has its finish time, and the page keeps following it until then", () => {
  const cancelling = { state: "cancelled", finishedAt: null, counts: { issued: 2, succeeded: 1, verified: 3, cancelled: 4 } };
  assert.equal(jobPhase(cancelling), "cancelling");
  assert.equal(keepFollowing(cancelling), true);
  assert.equal(phaseText(cancelling), "Cancelling: finishing the 3 cabinets already sent");
  const one = { ...cancelling, counts: { issued: 1 } };
  assert.equal(phaseText(one), "Cancelling: finishing the cabinet already sent");
  const nothingSent = { ...cancelling, counts: { cancelled: 5 } };
  assert.equal(phaseText(nothingSent), "Cancelling: ending the job");
  const ended = { ...cancelling, finishedAt: at };
  assert.equal(jobPhase(ended), "cancelled");
  assert.equal(keepFollowing(ended), false);
  assert.equal(phaseText(ended), "Cancelled");
});

test("running and finished jobs read as before", () => {
  assert.equal(phaseText({ state: "running", finishedAt: null, counts: {} }), "Running");
  assert.equal(keepFollowing({ state: "running", finishedAt: null, counts: {} }), true);
  assert.equal(phaseText({ state: "done", finishedAt: at, counts: { verified: 3 } }), "Finished");
  assert.equal(keepFollowing({ state: "done", finishedAt: at, counts: {} }), false);
  assert.equal(keepFollowing(null), false);
  assert.equal(keepFollowing(undefined), false);
});

test("counts that are not whole positive numbers count as none, so a bad answer never makes up cabinets", () => {
  for (const v of [-2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, undefined, {}, []])
    assert.equal(stillSent({ issued: v, succeeded: v }), 0, String(v));
  assert.equal(stillSent(null), 0);
  assert.equal(stillSent({ constructor: 4, __proto__: 5 } as never), 0);
});

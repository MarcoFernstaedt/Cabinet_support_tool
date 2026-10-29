// No bulk restarts (docs/spec/09-open-decisions.md "No bulk restarts", the owner's decision, 2026-10-29, for security): a restart is
// sent to one cabinet at a time from its own page, never as a fleet job. Neither the server's list nor the contract may carry it.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { consoleBodies } from "../src/contracts.js";
import { JOB_OPERATIONS } from "../src/services/fleet-jobs.js";

test("a restart or shutdown is never a fleet job operation", () => {
  assert.ok(!(JOB_OPERATIONS as readonly string[]).includes("system.restart"));
  const body = { jobId: randomUUID(), operation: "system.restart", cabinetIds: [randomUUID()], batchSize: 1, stepUpToken: "x".repeat(43) };
  assert.equal(consoleBodies.fleetJob.is(body), false);
  // The same body with an operation that is allowed passes, so the refusal above is the operation's.
  assert.equal(consoleBodies.fleetJob.is({ ...body, operation: "time.sync" }), true);
});

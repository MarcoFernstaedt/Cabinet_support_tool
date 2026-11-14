# Task: fleet job recovery after a runner dies

Repository: `/home/marco/cabinet_support_tool`. Read this file and execute it exactly as written. Stay inside the repo.
Do not commit. Leave the changes in the working tree.

## What already exists — do not re-do it

- `server/src/services/job-lease.ts` — `takeLease`, `leased`, `ownedPool`. A runner acts on a job only while it holds
  the job's database lease; the lease is renewed each run; another instance takes over only once the holder stops
  renewing and the lease runs out. Lease taking and renewing is one statement under a key-range lock.
- `server/src/services/fleet-jobs.ts` — `startJob` (`:154`) checks the confirmation, the pauses and the limit and fixes
  the target list; `runJob` (`:199`) runs one job to its end and is documented as "only while holding its database
  lease, for route and recovery callers alike"; `issueBatch` (`:243`) and `followUp` (`:326`) do the per-cabinet work;
  `cancelJob` (`:462`) cancels.
- `resumeJobs` (`fleet-jobs.ts:424`) — resumes jobs that are already marked running.
- `scheduleFleetRecovery` (`fleet-jobs.ts:432`) — the existing recovery path. Its comment states the limit: it retries
  **startup acquisition, not failed work**, from a snapshot of running jobs taken **once**, and "Cancelled jobs and
  failed runners retain existing recovery behaviour."
- Tests (all under `server/test/`, TypeScript, compiled to `dist/test/`): `fleet-jobs.test.ts`,
  `fleet-jobs-preview.test.ts`, `fleet-jobs-retention.test.ts`, `fleet-jobs-sync-last.test.ts`,
  `fleet-jobs-no-restart.test.ts` (the last is about the no-bulk-restart rule, not about this task).
- How tests run here: `server/package.json` → `"test": "npm run build && node --test --test-concurrency=2 dist/test/*.test.js"`.
  The suite runs the **compiled** files in `dist/test/`, so a build must precede any test run.

## The defects — named, with the wrong behaviour

1. **A job whose runner dies is stranded until the process restarts.** `scheduleFleetRecovery` snapshots running jobs
   once at boot and only retries acquiring them. A job started after boot whose runner then dies mid-job, and a job
   whose runner dies after the startup snapshot has been consumed, are both left `running` with an expiring lease and
   nobody picks them up. Wrong behaviour: the lease mechanism exists precisely so another runner can take over, and it
   never gets asked to.
2. **A transient query failure abandons the job instead of continuing it.** Inside `runJob`, an error that escapes the
   per-batch work ends the run for that job rather than leaving it to be resumed. Wrong behaviour: a transient database
   error ends a fleet job that is still perfectly valid.
3. **A cancelled job leaves outstanding commands unreconciled.** `cancelJob` marks the job cancelled; commands already
   issued to cabinets are not driven to a terminal state, so a cabinet's command can sit pending against a job that
   will never run again. Wrong behaviour: after cancellation the job's outstanding commands are left in limbo.

## Required behaviour

- A job in `running` with no live lease holder is picked up again **without a process restart**, within a bounded
  interval. Do not shorten the lease to fake this.
- A runner that hits a transient database error continues or safely yields the job, so the next runner resumes it.
- A cancelled job reconciles its outstanding commands to a terminal state (verified, failed or expired — use the
  vocabulary the schema and the existing code already use; invent nothing).
- Recovery must remain safe with two instances: exactly one runner may act on a job at a time, and the existing
  "one lifecycle owner" test must still pass unmodified.
- The safety rule stands: nothing here may issue, re-issue or re-apply a change to a cabinet that already has an
  outstanding command for the same step.

## Not in this task

- Item 2 of `docs/build-program-2026-11-14.md` (the single 150 s batch deadline) and item 3 (console pagination).
- Any schema change to job, command or lease tables unless it is genuinely required — if it is, say so in the summary
  and add the migration in the same change.
- No reformatting, no renames, no dependency additions, no touching unrelated services or tests.
- Do not weaken or rewrite any existing assertion. If an existing test must change to fit the new behaviour, stop and
  report it instead.

## Acceptance commands

Run from `server/`, and paste the exact output into your summary:

```bash
cd /home/marco/cabinet_support_tool/server
npm run build                                        # must succeed; tsc emits dist/
node --test dist/test/fleet-jobs.test.js             # existing lifecycle tests, must stay green
node --test dist/test/fleet-jobs-preview.test.js
node --test dist/test/fleet-jobs-retention.test.js
node --test dist/test/fleet-jobs-sync-last.test.js
cd /home/marco/cabinet_support_tool
git status --short
git diff --stat
```

The tests need the SQL Server test container on `127.0.0.1:11433`; if it is down, say so and report the tests as
unrun rather than reporting a pass.

Plus one red/green proof for the new mechanism: the test you add for defect 1 must go **red** with the resume path
disabled (make the comparison `if (false)` so the build stays valid, or remove the guard), and green again with the
file restored byte-identical. Paste both runs and the restoring `cmp` result.

Report at the end: what you changed, the exact commands and their output, what is still unverified, and anything you
found outside this task's scope.

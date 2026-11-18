# Task: one deadline per batch lets the slowest cabinet set the pace

Repository: `/home/marco/cabinet_support_tool`. Read this file and execute it exactly as written. Stay inside the repo.
Do not commit. Leave the changes in the working tree.

## What already exists — do not re-do it

- `server/src/services/fleet-jobs.ts` → `runJob` (`:199`) runs one job while holding its per-job lease; it takes a batch
  from `issueBatch` (`:245`) and hands it to `followUp` (`:328`), then loops while the job is running.
- `followUp` (`:328`) polls the batch to completion. Two deadlines live in it, and they disagree:
  - `:333` — `const deadline = Date.now() + 150_000;` — a **hard-coded literal, shared by the whole batch**, driving the
    `while (waiting.size > 0 && Date.now() < deadline)` loop at `:334`.
  - `:359` — `const verifyBy = Date.now() + timing.verifyMs;` — configurable, and per the existing conventions.
- `Timing` (`:30`) is `{ pollMs, verifyMs }`, `DEFAULT_TIMING` (`:32`) is `{ pollMs: 1000, verifyMs: 150_000 }`.
- Tests pass their own `Timing` (e.g. `{ pollMs: 50, verifyMs: 5_000 }`) so behaviour can be exercised in milliseconds.
- Recovery now resumes unfinished jobs from any runner (`runJob`/`resumeJobs`/`scheduleFleetRecovery`), so a batch that
  stops early is no longer lost — but the operator still sees a job that appears to hang and then settles partially.
- Cabinets go offline: migration `0028_fleet_job_offline.sql` reworked the target state check. Read that migration and
  the existing code for the vocabulary already in use. Invent nothing.
- `server/test/scale-fleet.test.ts` covers fleet-scale behaviour; `server/test/fleet-jobs.test.ts` is the main suite.

## The defects — named, with the wrong behaviour

1. **One deadline for the whole batch.** The batch polls for 150 s *in total*. A batch that contains one cabinet which
   never answers burns the remaining targets' budget: the loop exits with targets still `issued`, so a job that should
   finish in seconds waits the full 150 s and then stops part-way. Wrong behaviour: the slowest cabinet sets the pace
   for every other cabinet in the batch.
2. **The batch budget is not configurable and does not come from `Timing`.** The literal cannot be tuned per environment,
   and no test can reach it — which is why this defect has no test today. `verifyMs` right below it shows the intent.
3. **Offline cabinets are not distinguished from slow ones.** A cabinet known to be offline should not hold a batch open
   at all; it should reach the terminal state the code already uses for that case, promptly, and be reported as such.

## Required behaviour

- Each target gets its **own** budget: one cabinet cannot consume another's. A batch finishes as soon as its targets
  reach terminal states, and no target's fate is decided by a neighbour's slowness.
- The batch budget comes from `Timing` (add a field; keep `DEFAULT_TIMING`'s effective behaviour at today's value) so it
  is tunable and testable.
- A target that exhausts its budget reaches a terminal state from the vocabulary the schema and the code already use —
  do not invent states, and do not leave a target `issued` with the job still running.
- A cabinet already known to be offline is not waited for at all.
- Polling must stay bounded at fleet scale: no unbounded fan-out of queries per target, and no per-target timer that
  lives longer than the batch (see `scale-fleet.test.ts` for the existing scale expectations).
- Unchanged: the per-job lease ownership rule (exactly one runner per job), the no-reissue rule (a target that already
  has a command for this step must never be issued a second one), and the sync-cabinet safety rule.

## Not in this task

- Item 1 has already landed (continuous recovery) — do not re-open or rewrite it.
- Console fleet pagination — different PR.
- No schema or migration change unless it is genuinely required; if it is, say so in the summary and add the migration.
- No reformatting, no renames, no dependency additions, no touching unrelated services, routes or tests.
- Do not weaken or rewrite any existing assertion. If an existing test must change to fit the new behaviour, stop and
  report it instead — that is a finding, not plumbing.

## Acceptance commands

Run from `server/`. The DB-backed tests need the disposable SQL Server test container on `127.0.0.1:11433` **and** the
admin URL in the environment; without `TEST_DATABASE_ADMIN_URL` every case fails on connection, which is not a code
defect and must never be reported as one. Never point these tests at the live platform database.

```bash
cd /home/marco/cabinet_support_tool/server
SA=$(docker inspect cab-test-mssql --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MSSQL_SA_PASSWORD=//p')
export TEST_DATABASE_ADMIN_URL="sqlserver://sa:${SA}@127.0.0.1:11433/master?trustServerCertificate=true"
export PATH="$HOME/.dotnet:$PATH"                       # agent-spawning e2e starts `dotnet` by name
npm run build                                           # must succeed; tsc emits dist/
node --test --test-timeout=600000 dist/test/fleet-jobs.test.js
node --test --test-timeout=600000 dist/test/fleet-jobs-preview.test.js
node --test --test-timeout=600000 dist/test/fleet-jobs-retention.test.js
node --test --test-timeout=600000 dist/test/fleet-jobs-sync-last.test.js
node --test --test-timeout=600000 dist/test/fleet-jobs-no-restart.test.js
node --test --test-timeout=600000 dist/test/scale-fleet.test.js
cd /home/marco/cabinet_support_tool
git status --short
git diff --stat
```

Baseline before your change, measured by the reviewer at the merged head of item 1: `fleet-jobs` 17 tests / 17 pass,
`preview` 7/7, `retention` 2/2, `sync-last` 6/6, `no-restart` 1/1 — 33 tests, 33 pass, 0 fail; `scale-fleet` 5 tests / 5 pass. Report `scale-fleet`'s own
numbers after your change yourself; do not assume them.

`--test-timeout` is not optional: files here have hung indefinitely on this host. Take the verdict from the
`# tests / # pass / # fail / # skipped` summary — a bare exit code with no summary means no tests ran. If the container
is down, report the tests as unrun rather than reporting a pass.

Then the red/green proof, which must show the new test actually detects the defect: with the per-target budget disabled
(one shared deadline as before, or the new value pinned back to the old shared literal), the new test must go **red**;
with the file restored byte-identical (`cmp`), it must be green. Paste both runs and the `cmp` result.

Report at the end: what you changed, the exact commands and their output, the before/after numbers, what is still
unverified, and anything you found outside this task's scope.

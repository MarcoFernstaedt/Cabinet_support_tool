# Task: fix two findings in the per-target fleet budget change

Repository: `/home/marco/cabinet_support_tool`. The working tree already holds the previous attempt at this task
(`server/src/services/fleet-jobs.ts`, `server/test/fleet-jobs.test.ts`, and an untracked `task-results/` directory that
must not be committed). Read the existing brief `docs/codex-tasks/fleet-batch-deadline.md` first for the intent, then fix
the two findings below. Keep everything else in the change. Stay inside the repo. Do not commit and do not write scratch
files inside the repository — use `/home/marco/.hermes/cache/scratch/` for logs and reports.

## What is right in the current change — keep it

- Each target's budget is derived from the durable `commands.issued_at`, so recovery does not grant an unanswered
  command extra time. Keep that property.
- Answered targets carry their own verification window and reach `verified` / `not_verified` independently.
- No existing assertion was changed, and the loop now drains `answered` inside the loop, which removes the post-loop
  cleanup.

## Finding A (must fix) — a known-offline cabinet is reported as untouched while its change can still be applied

`followUp` now marks a target `offline` when the cabinet's heartbeat is stale **or** the command expired:

```
} else if ((r.status === "expired" || !r.online) && !(r.delivered === true || r.delivered === 1)) {
  await setTarget(pool, jobId, t.cabinet_id, "offline", "The cabinet was out of contact and never took the command; nothing was changed on it. ...");
```

Before the change this branch required `r.status === "expired"`, i.e. a command that was queued for the whole job and
therefore never taken. With `|| !r.online` the target is now marked offline while its command is **still `queued` and
still deliverable**. When that cabinet's agent comes back — a cabinet that was asleep, paused, or off-network for a while
is the normal case at fleet scale — it takes the command and applies the change, while the operator has been told
"nothing was changed on it. Run the job again for it once it is back." The job also finishes with a command of its own
still outstanding. That is a misreport of the fleet's state, on the screen a support person trusts.

Required: choose one and assert it.

1. Make the statement true — expire or cancel the command before marking the target offline, so the change can never be
   applied later and "nothing was changed" is accurate; or
2. Do not mark offline until the command is no longer deliverable, and instead let the target reach the terminal state
   the code already uses when a command expires undispatched.

Either way, a target reported offline must have no command that can still be taken by an agent, and the job must not
finish while one of its commands is still outstanding. Use only the state vocabulary the migration and the existing code
already use. Do not invent a state.

## Finding B (must fix) — the poll loop can spin forever if a command row disappears

The loop is now `while (waiting.size > 0 || answered.length > 0)`, and a target leaves `waiting` only inside
`for (const r of rows)`. The row set comes from a query over `commands` by id, so **a waiting target whose command row is
missing from that result never gets its budget evaluated and never leaves `waiting`** — the runner then polls every
`pollMs` forever while holding the job's lease, so no other runner takes the job either. Rows can go missing: command
retention prunes rows, and the job keeps running. The pre-change code could not spin this way, because its shared
`deadline` sat in the `while` condition.

Required: the loop must terminate independently of whether each command row comes back — for example carry each waiting
target's `issued_at` from the batch (or from the same query that issues it) and evaluate its budget from that, and/or put
a ceiling on the loop that does not depend on the row set. Add a test that removes a waiting target's command row
mid-flight and asserts the runner finishes, marks that target with a terminal state, and does not spin.

## Finding C (must fix) — `server/test/fleet-jobs-sync-last.test.ts` now hangs

Measured by the reviewer on your working tree: the file passes its first three tests and then hangs until a 420-second
wall-clock timeout kills it (`rc=124`). On the merged tree it was 6 tests / 6 pass / 0 fail. A hang is the worst failure
mode here — it is what Finding B predicts, and it means the sync-cabinet ordering path no longer terminates. Diagnose
and fix it, and make the file report 6/6 again. If the cause turns out to be a third thing rather than A or B, say so
plainly in your summary and explain the mechanism.

## Not in this task

- Do not re-open item 1 (continuous recovery) or change the lease rules.
- No schema or migration change.
- No reformatting, no renames, no new dependencies, no touching unrelated services, routes or tests.
- Do not weaken or rewrite any existing assertion; if one must change, stop and report it.
- Do not commit, and do not create directories or files inside the repository other than the two source files.

## Acceptance commands

Run from `server/`. The DB-backed tests need the disposable SQL Server container on `127.0.0.1:11433` and the admin URL
in the environment; without `TEST_DATABASE_ADMIN_URL` every case fails on connection, which is not a code defect.

```bash
cd /home/marco/cabinet_support_tool/server
SA=$(docker inspect cab-test-mssql --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MSSQL_SA_PASSWORD=//p')
export TEST_DATABASE_ADMIN_URL="sqlserver://sa:${SA}@127.0.0.1:11433/master?trustServerCertificate=true"
export PATH="$HOME/.dotnet:$PATH"
npm run build
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

Baseline to preserve, measured by the reviewer on the merged tree: `fleet-jobs` 17/17, `preview` 7/7, `retention` 2/2,
`sync-last` 6/6, `no-restart` 1/1, `scale-fleet` 5/5 — 38 tests, 38 pass, 0 fail. Report the numbers you actually get.

Take every verdict from the `# tests / # pass / # fail / # skipped` summary. If the container is unreachable, say so and
report the tests as unrun — never as a pass. If a database call fails from inside your sandbox, say so plainly; the
reviewer runs the suite.

Red/green: with the per-target budget disabled (a single shared deadline as before, or `batchMs` pinned back to being
shared across the batch), your new tests for Findings A and B must each go **red**; restore the file byte-identical
(`cmp`) and they must be green. Paste both runs and the `cmp` result.

Report at the end: what you changed, the exact commands and their output, which of the two options you chose for
Finding A and why, what remains unverified, and anything found outside this task's scope.

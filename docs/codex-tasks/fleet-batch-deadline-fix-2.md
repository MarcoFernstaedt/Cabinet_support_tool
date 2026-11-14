# Task: round 3 — the withdrawal must satisfy `expires_at > issued_at`

Repository: `/home/marco/cabinet_support_tool`. The working tree holds your fix from the previous round. A reviewer ran it:
**Finding C is fixed** (`fleet-jobs-sync-last` 6 tests / 6 pass), and `preview` 7/7, `retention` 2/2, `no-restart` 1/1,
`scale-fleet` 5/5 all pass. Everything is green except one test, and it fails deterministically (both runs, ~800 ms):

```
not ok 20 - a waiting command removed mid-flight cannot keep the runner polling
error: 'The INSERT statement conflicted with the CHECK constraint "commands_check" ...
        table "dbo.commands"'
```

## The finding

`server/migrations/0001_baseline.sql:301` defines `CONSTRAINT [commands_check] CHECK ((expires_at > issued_at))` —
strictly greater, not `>=`.

1. **Your test breaks it.** The restore insert in the `finally` of
   `a waiting command removed mid-flight cannot keep the runner polling` writes `issued_at = SYSUTCDATETIME()` and
   `expires_at = SYSUTCDATETIME()` in the same statement, so `expires_at > issued_at` cannot hold. Fix the restore so the
   row is valid — an `issued_at` in the past and an `expires_at` a minute later, with a status that matches, from the
   vocabulary the schema allows: `queued`, `delivered`, `succeeded`, `failed`, `rejected`, `expired`.
2. **The withdrawal in `followUp` only avoids the same trap by accident.** It sets
   `expires_at = CASE WHEN expires_at > SYSUTCDATETIME() THEN SYSUTCDATETIME() ELSE expires_at END`. That is `<= now`
   while `issued_at` is always `< now` in production, because a production poll happens about a second after the command
   is issued (`pollMs: 1000`). Nothing in the code states or enforces that. A poll at the same instant as the insert, or
   a caller with `pollMs` near zero, produces `expires_at <= issued_at` and the runner dies on a constraint error instead
   of reporting a target state.

Required: make the invariant explicit and enforced in the code, not implied by a timing accident. Either keep the
withdrawal strictly above `issued_at` (one millisecond is enough — an agent polling a moment later still sees the command
as expired), or do not retire a command whose `issued_at` is not yet strictly older than the retirement instant. Assert
it in a test: a command issued and retired in the same statement-window must not raise and must reach a terminal state.

Do not change the migration. The constraint is right; the code has to satisfy it.

## Not in this task

- Nothing else. Do not touch the other tests, the shape of the loop, the offline withdrawal semantics (Finding A is
  verified fixed), the missing-row handling (Finding B is verified fixed), or any file other than
  `server/src/services/fleet-jobs.ts` and `server/test/fleet-jobs.test.ts`.
- No schema or migration change, no reformatting, no renames, no new dependencies.
- Do not weaken or rewrite any existing assertion; if one must change, stop and report it.
- Do not commit, and do not create files or directories inside the repository — logs go to
  `/home/marco/.hermes/cache/scratch/`.

## Acceptance

Same block as before (from `server/`, with `TEST_DATABASE_ADMIN_URL` exported and the `cab-test-mssql` container up; your
sandbox returns EPERM on 127.0.0.1:11433, so state plainly what you could not run — the reviewer runs it).

The reviewer's measured baseline for your working tree, to be preserved except for the one failure: `fleet-jobs`
19/20 (only this test failing), `preview` 7/7, `retention` 2/2, `sync-last` 6/6, `no-restart` 1/1, `scale-fleet` 5/5.

Report at the end: what you changed, which of the two options you chose for the retirement invariant and why, the exact
commands and output you did get, and what remains unverified.

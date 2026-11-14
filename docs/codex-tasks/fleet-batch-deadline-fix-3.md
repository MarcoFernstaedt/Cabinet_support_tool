# Task: round 4 — a withdrawn command writes its audit row

Repository: `/home/marco/cabinet_support_tool`. Read `CONTRIBUTING.md` first. The working tree holds your last round; a
reviewer ran the repository's full server suite against it and it fails on one test — the audit sweep.

## The finding (D)

`server/test/audit-sweep.test.ts:98` is the repository's own invariant — F4, `docs/spec/05-server-spec.md`, "Audit log":
*every statement that changes a row's state or status sits in a function that writes an audit row, or is listed with the
reason it is not a transition.* It fails on your change:

```
not ok 133 - every state change and every delete in the server is audited, or listed with the reason it is not a transition
  state changes with no audit row:
  services/fleet-jobs.ts:339 `UPDATE commands SET status = CASE WHEN delivered_at IS NOT NULL OR NOT EXISTS
```

Your retirement at `fleet-jobs.ts:339` moves a command to `expired` or `failed` with no audit row, in no transaction.

The repository already answers this case, and your path disagrees with it. `server/src/services/commands.ts:250` retires
an expired command with `UPDATE commands SET status = 'expired'` — and at `:260`, **in the same transaction**, writes
`auditMany` rows with `actorKind: "system"`, `actorId: "command-expiry"`, `action: "command.expire"`, one per command.
The exemption list gives this exact reason for the commands table: *"a delivery lease, renewed on every re-offer; the
command's issue, result and expiry are audited."* Your path expires and fails commands without that row, so the sentence
is no longer true, and the audit trail loses the fact that an operator was told a change would not happen — which is the
whole point of decision-log D46.

## What to change

1. **Write the audit row, in the same transaction as the retirement**, using the action the codebase already uses for a
   command reaching its end (`command.expire`, `actorKind: "system"`) — one row per retired command, with the command id
   and the outcome (withdrawn expired vs failed) recorded, and the job it belongs to in the details. The row must identify
   the path that ended it, because the reason matters: one of these commands was never delivered and the operator may have
   been told nothing was tried on the cabinet.
2. **Do not add the statement to `NOT_TRANSITIONS`.** That list is for statements that are not transitions; this is the end
   of a command, and the existing path audits it. Arguing an exemption here would make the audit trail worse and the
   invariant weaker.
3. Keep everything else as it is: the per-target budget, the terminal state reached in one statement with the withdrawal,
   the missing-row handling, and the `expires_at > issued_at` guard all stay exactly as they are.

## Tests

- A behavioural test: a command retired by this path has its audit row — action, actor, target id and outcome — and the
  state change and the row are one fact (a retirement that fails to audit must not have happened).
- `server/test/audit-sweep.test.ts` must pass. Run it yourself.
- Change no existing assertion; if one must change, stop and report it.

## Not in this task

Only `server/src/services/fleet-jobs.ts` and `server/test/fleet-jobs.test.ts`. No migration, no change to
`commands.ts` (reuse its action name and shape; do not refactor it), no reformatting, no new dependencies.
Do not commit; write no files inside the repository — logs go to `/home/marco/.hermes/cache/scratch/`.

## Acceptance

From `server/`, with `TEST_DATABASE_ADMIN_URL` exported and `cab-test-mssql` up: the build, your six fleet files
(`fleet-jobs`, `fleet-jobs-preview`, `fleet-jobs-retention`, `fleet-jobs-sync-last`, `fleet-jobs-no-restart`,
`scale-fleet`) and `audit-sweep`. Report each file's own numbers and exit code, and say plainly that your sandbox cannot
reach the database (`EPERM` on 127.0.0.1:11433) if that is still true — the reviewer runs these.

Reviewer-measured on your current tree: `fleet-jobs` 21/21, `preview` 7/7, `retention` 2/2, `sync-last` 6/6,
`no-restart` 1/1, `scale-fleet` 5/5, `audit-sweep` failing on this one statement. The full server suite is
1093 tests / 1082 pass / 1 fail / 10 skipped, and that single failure is this.

Red/green: neuter your audit (remove the `auditMany` call), watch the new test and `audit-sweep` go red, restore the file
byte-identical (`cmp`), watch both go green. Say which edit you used.

# Task: scheduled cabinet restarts, by site and by cabinet, with the sync cabinet first

**Status: ready to run. Revision 1 (2026-11-15).**

Marco's instruction, verbatim: *"Let's do the reboot time and ensure sync cabinets are first since they need to be on
before satellites."*

Two cabinets are going out this week — a satellite site and a sink cabinet — and a site's cabinets cannot all be
restarted at once: the cabinet that the site uses as its sync point has to be up before the satellites that talk to it.
Today a human clicks restart, and the order is whatever order they click in.

## What already exists (read these before writing anything; do not rebuild them)

- **The restart primitive is built.** `contracts/schemas/operations/system.restart.schema.json` already takes
  `mode` (`restart` | `shutdown` | `cancel`), `delaySeconds` (0-3600) and a message shown at the cabinet's screen. It runs
  `shutdown.exe` by full path with an argument array, and a shutdown already requires an Admin because a cabinet that is
  off stays off until someone walks up to it.
- **Fleet jobs already exist and already have one lifecycle owner.** `server/src/services/fleet-jobs.ts` drives an
  operation across many cabinets, with per-target states, a lease, cancel reconciliation and a terminal state for a
  cabinet that was out of contact. **Reuse it. Do not write a second thing that issues commands.**
- **A site already knows its timezone and its sync point.** `server/migrations/0001_baseline.sql:87` — `sites` carries
  `time_zone` (`nvarchar(64)`), `sync_address`, `sync_ports`, `watched_services` and `network_baseline`. A schedule
  attached to a site therefore knows the local time to fire in, and which cabinet must come back first.
- **`maintenance.ts`'s `HH:MM` is not yours.** That is the *server's* own daily upkeep (retention sweep, error trends).
  Do not extend it for cabinets and do not reuse its parser for a different purpose.
- **Reminder of the invariants you must not bend** (`CONTRIBUTING.md`, `docs/spec`): one lifecycle owner per fleet job;
  never issue a change twice; every write is allowlisted, role-gated, confirmed and logged; a misreport of fleet state is
  a defect, not a cosmetic bug; sync-cabinet safety comes first.

## Part 1 — the schedule

1. **A restart schedule belongs to a site by default and to a cabinet as an override.** A site gets at most one default
   schedule (a time of day, which days, whether it is enabled, what mode, the delay in seconds, and the message shown at
   the screen). A cabinet may carry its own schedule, which wins over the site's. "Off" must be expressible — a cabinet
   that is excluded from a site-wide schedule must be excluded, not rebooted anyway.
2. **Times are wall-clock times in the site's timezone.** `sites.time_zone` exists; use it. Store the schedule so that a
   timezone change on the site moves the local time it fires at, or state plainly in your report why you stored it
   otherwise. Never fire a "3am reboot" at 3am UTC for a cabinet in Phoenix.
3. **Additive migration only.** A new migration file, following the numbering and style of the existing ones. No
   destructive change, no column dropped, nothing that touches a live cabinet's data.
4. **The schedule is data with a history.** Who changed it and when must be answerable afterwards, in the same way the
   rest of the platform answers that question — find the existing pattern for change history (grep for `config_changes`
   and the audit rows the fleet writes) and follow it. Do not invent a second audit mechanism.

## Part 2 — the runner, and the order it must respect

5. **A due schedule turns into a fleet job, through the existing machinery.** One lifecycle owner, the existing per-target
   states, the existing cancel behaviour. If a run is still in flight when the next one comes due, it must not start a
   second one — say what the rule is in your report.
6. **The sync cabinet is commanded first, and satellites wait for it to be *back*, not merely commanded.**
   - The site's sync point is on the site row (`sync_address`/`sync_ports`). Identify the sync cabinet by the existing
     means — read how the platform already decides which cabinet a site's satellites sync through
     (`server/src/services/sync-cabinets.ts`) and use that, do not invent a second definition of "the sync cabinet".
   - Satellites are not commanded until the sync cabinet has come back **and has reported for duty again** — a fresh
     reading, not a stale one and not "the command was accepted". A cabinet that has not reported must be treated as not
     back. Waiting has a bound: state the timeout, and what happens to satellites when it is exceeded (they are left
     uncommanded and the run says so, rather than being restarted blind).
   - A site with no sync cabinet, or with a single cabinet, is the trivial case: command it and finish.
7. **The same order applies to a manual fleet restart**, not only a scheduled one — the danger is the order, not the
   trigger. If that is a larger change than it looks, say so in your report rather than half-doing it.
8. **Nothing about a scheduled restart may be silent.** The run's outcome must be readable afterwards: which cabinets
   were commanded, which answered, which were skipped, and why.

## Part 3 — the console

9. **The console is where a support person sets this, so it must read like a support tool, not an admin form.** A site's
   page shows its restart schedule in the site's local time, with the next run stated in the same local time; each
   cabinet's page shows whether it inherits the site's schedule or overrides it, and what the effective next run is.
   Editing follows the console's existing conventions for risky writes (the confirmation/step-up pattern already used
   elsewhere for Admin-gated actions) — reuse it, do not invent a new dialog style.
10. **A person must be able to see why a cabinet was not rebooted.** "Skipped: waiting for the sync cabinet" and "skipped:
    the sync cabinet never came back" are different sentences and the UI must say which.

## Rules this task must not break

- `docs/spec` is the source of truth. If a spec sentence contradicts what you build, your report says so; you do not edit
  the spec.
- **Do not weaken or edit any existing test.** New behaviour gets new tests. If existing behaviour has to change, stop and
  report it instead.
- TypeScript stays strict; server and console must both type-check clean.
- No new dependency, no upgrade, no reformatting of code you were not asked to change.
- **Do not touch the demo mode** — that is a separate task with its own brief. Do not touch service start order, which is
  its own task as well.
- No commits. Leave everything in the working tree for review.

## Acceptance — run these and paste the exact output

```sh
cd /home/marco/cabinet_support_tool

echo "== the tree was clean when I started =="
git status --short | wc -l      # expect 0 at the time you began

echo "== type-checks =="
(cd server && npx tsc --noEmit) && echo "server tsc OK"
(cd console && npx tsc --noEmit) && echo "console tsc OK"

echo "== suites (baseline: server 1089 pass / 0 fail / 10 skip, console 29 files green) =="
(cd server && npx vitest run --reporter=basic 2>&1 | tail -20)
(cd console && npx vitest run 2>&1 | tail -12)

echo "== what changed =="
git diff --stat | tail -25
git status --short

echo "== how the sync-first rule is enforced, in code =="
grep -rn "sync" server/src/services/*restart* server/src/services/*schedule* 2>/dev/null | head -20
echo "State the file:line where a satellite is held back, and the file:line where a cabinet is judged to be back."
```

The database for tests is already running on this host (`127.0.0.1:11433`). If your sandbox cannot reach it, say so
plainly and say which tests you therefore could not run — **never report a suite as passing that you did not run.** A
suite that cannot be run is reported as not run.

## Report, in this order

1. Every file added and every file changed, each with a one-line reason.
2. The schema you added (columns, constraints, migration number) and why it is additive.
3. The exact code path a due schedule takes, from the timer to the command reaching a cabinet, with file:line references.
4. **The sync-first rule**: where a satellite is held back, what counts as "back", the timeout, and the wording a support
   person sees in each of the three cases (waited and succeeded; waited and timed out; skipped).
5. The acceptance output verbatim, plus before/after test counts.
6. Anything you found that contradicts this brief, and anything you deliberately did not touch.

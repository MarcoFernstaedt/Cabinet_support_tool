# Task: see a cabinet's service start order, and catch it drifting

**Status: ready to run. Revision 4 (2026-11-15).** Three runs stopped on this brief before any code was written, all three
correctly: revisions 1 and 2 asked for a write the spec does not define, and revision 3 claimed a drift change would
"let the existing drift → alert path do the rest", which is false — `server/src/services/baseline-drift.ts:111` is the
only `upsertAlert` call in that file and it is `checkFirmware` alone, a documented exception for BIOS fields
(decision-log **D48**: *"drift only feeds health … and nothing raised an alert"*). Revision 4 states the real scope:
**baseline drift and health, no alert.** Do not add an alert policy; if the owner wants one later it is a spec decision,
not an improvised policy inside this task.

## Why this exists

Marco's instruction: *"I'd like to make sure services start in a specific order as well."* Today the platform can list a
cabinet's services and their recovery actions, but it cannot say **what waits for what** when a cabinet boots — so a
service that comes up too early looks like a broken cabinet and the alert names the wrong component. The spec already
says this belongs to the platform: `docs/spec/12-milestones-8-to-12.md:51` defines `services.list` as "every Windows
service, with:" a list that includes the dependencies, and `:84` names "the dependencies of F14.R1" as work the agent
owes. It has not been built.

## What already exists — read these before writing anything

- **`services.list` is built and already returns a lot.** `contracts/schemas/operations/services.list.schema.json` and
  `agent/src/Cabinet.Agent.Windows/ServicesAndProcesses.cs`. A previous run's recon — which you should **re-check rather
  than trust** — found display name, start type **including delayed-auto**, running state, logon account and recovery
  actions already read, and **configured dependencies and reverse dependencies missing**. Confirm that by reading the
  schema and the agent before you change either.
- **The spec's own field list for `services.list`** is `docs/spec/12-milestones-8-to-12.md:51`-`:57`. **Read it
  carefully**: as written, that list does **not** contain the dependencies — a previous brief of mine claimed it did and
  was wrong. What plans them is `:84`, which names *"the dependencies of F14.R1"* as work the agent owes. Build to the
  spec's list *plus* the dependencies that `:84` plans, and say in your report where the two disagree.
- **A baseline mechanism for exactly this kind of drift already exists:** `docs/spec/15-baselines-and-config.md:16` lists
  a `services` baseline keyed `service:<name>` holding start type, state and account, fed by the `services.list` reader.
  "Declared vs real" belongs there — extend that mechanism, do not invent a second one.
- **Recovery actions are dangerous in one specific way, and already handled:** `server/src/services/service-recovery.ts`
  parses `none`/`restart`/`reboot`/`run_program` and groups the services whose recovery would **restart the whole
  cabinet**. Nothing in this task may issue a reboot.
- **The agent is Windows-only and this host is Linux.** You cannot run agent tests here. Say so; do not claim them.

## The job, in order

1. **Add the two missing reads to `services.list`:** a service's **configured dependencies** (what it needs) and its
   **reverse dependencies** (what needs it). Read them from Windows itself — `sc.exe qc`, or the Service Control Manager
   API if the agent already uses it elsewhere. **Do not invent an ordering Windows does not enforce:** an order the
   console displays but Windows ignores is worse than no display at all, because it misreports the fleet.
2. **Show the effective start order for a cabinet** on the Services tab, so a person can answer "what comes up first
   here, and what waits for what" without opening `services.msc` on the cabinet. Where the order cannot be determined
   from what the agent reports, the console says **that** — "could not check" is a valid and required answer, never a
   guessed order and never healthy.
3. **Make a drifted dependency show up the way drift already shows up — and no further.** Read
   `server/src/services/baseline-drift.ts` before writing anything. It computes `DriftRow`s
   (`{category, itemKey, field, mode, expected, actual, origin, severity: "minor"|"major", required}`), stores them in
   `cabinet_drift`, and feeds the Baseline tab and the health evaluation. **Drift does not raise alerts**: the file has
   exactly one `upsertAlert` call, `checkFirmware` at `:111`, which is a deliberate, documented exception for BIOS fields
   (decision-log **D48**). The certainty vocabulary (confirmed / probable / possible / could not check) belongs to the
   *diagnose* findings (`docs/spec/13-roadmap.md:163`), a different path again.
   So the work is narrow and it is this: **extend the `services` baseline item to carry the dependency list**, so a
   service that gains or loses a dependency shows as drift on the Baseline tab and in the health judgement, exactly as
   any other configuration drift does. **Do not add an alert, a finding, a table, a route or a lifecycle for it.** If you
   believe a dependency change deserves an alert, that is a finding for your report — it is the owner's decision, and
   `docs/spec/15-baselines-and-config.md:85` and D48 are the precedent it would have to follow.
4. **Hostile and malformed input.** The agent reads whatever Windows hands back. Cover: dependency list absent; empty;
   naming a service that does not exist; a service naming itself; and a cycle. A cycle is reported as a cycle, never
   rendered as an order.

## Out of scope, deliberately

- **Setting or changing a service's dependencies.** The spec defines no operation for it. Do not add one, do not add its
  contract, do not add a write path. It is a question for the owner and is recorded as one.
- **Any restart, reboot, shutdown, or service start/stop.** Reads only. `service-recovery.ts` is evidence you may read.
- **The demo mode, the restart schedule and the fleet job operations** — separate tasks with their own briefs.
- `server/migrations/` only if storage is genuinely required, and then additive only.

## Rules this task must not break

- `docs/spec` is the source of truth. If a spec sentence contradicts what you build, report it; do not edit it.
- **Do not weaken or edit any existing test.** New behaviour gets new tests.
- TypeScript stays strict; server and console must type-check clean. The agent stays `net10.0-windows` and keeps
  publishing both `win-x64` and `win-x86`.
- No new dependency, no upgrade, no reformatting code you were not asked to change.
- The invariants do not bend: one lifecycle owner per fleet job, never issue a change twice, every write allowlisted,
  role-gated, confirmed and logged, a misreport of fleet state is a defect, sync-cabinet safety first. This task issues
  no writes at all.
- No commits. Leave everything in the working tree for review.

## Acceptance — run these and paste the exact output

Use the repository's own runner: `server/package.json:12` is `npm run build && node --test --test-concurrency=2
dist/test/*.test.js`. There is no server Vitest.

```sh
cd /home/marco/cabinet_support_tool

echo "== the tree was clean when I started =="
git status --short | wc -l      # expect 0 at the time you began

echo "== type-checks =="
(cd server && npx tsc --noEmit) && echo "server tsc OK"
(cd console && npx tsc --noEmit) && echo "console tsc OK"

echo "== suites (baseline: server 1089 pass / 0 fail / 10 skip; console 29 test files, 117 tests) =="
(cd server && npm test 2>&1 | tail -20)
(cd console && npx vitest run 2>&1 | tail -12)

echo "== the new read is real =="
grep -n "depend" contracts/schemas/operations/services.list.schema.json | head -20
grep -n "depend" agent/src/Cabinet.Agent.Windows/ServicesAndProcesses.cs | head -20
echo "State the file:line the agent reads dependencies from."

echo "== what changed =="
git diff --stat | tail -25
git status --short
```

The test database is running on this host (`127.0.0.1:11433`). The agent is Windows-only — if a suite needs Windows, say
so and do not claim it. **Never report a suite as passing that you did not run.**

## Report, in this order

1. What a service already carries today, with file:line evidence, and what was genuinely missing — correcting the recon
   above if it was wrong.
2. Every file added and changed, one line of reason each.
3. **Why the order you display is the order Windows actually enforces**, and what the console shows when it cannot tell.
4. The drift half: how a gained or lost dependency reaches a support person, which existing path it rides, and the exact
   wording they see. No certainty vocabulary here — that belongs to diagnose findings.
5. The malformed-input cases tested and what happened in each (absent, empty, unknown name, self-reference, cycle).
6. Anything that contradicts this brief, the acceptance output verbatim, before/after test counts, and anything you could
   not run.

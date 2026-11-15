# Task: see a cabinet's service start order, and catch it drifting

**Status: ready to run. Revision 2 (2026-11-15).** Revision 1 also asked for the write half; a run stopped on
`docs/spec/STANDING-INSTRUCTIONS.md:21` — "if the spec does not answer something, stop and ask rather than guessing" —
because the spec plans dependency **reads** but defines no operation for **setting** service dependencies. Revision 2
drops the write. It is a question for the owner, not for you. Build the read half, which the spec does plan.

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
- **The spec's own field list for `services.list`** is `docs/spec/12-milestones-8-to-12.md:51`. Build to that, not to
  your own idea of what a services view should hold.
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
3. **Report drift against the baseline.** When a cabinet's real dependency graph no longer matches what the platform
   holds as its baseline, open the platform's existing drift finding, with the same certainty vocabulary the other
   findings use, and say what changed: which service gained or lost a dependency.
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
4. The drift finding: what counts as drift, the certainty vocabulary, and the exact wording a support person sees.
5. The malformed-input cases tested and what happened in each (absent, empty, unknown name, self-reference, cycle).
6. Anything that contradicts this brief, the acceptance output verbatim, before/after test counts, and anything you could
   not run.

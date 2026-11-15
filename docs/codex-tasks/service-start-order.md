# Task: services start in a specific order, and the platform can see and set it

**Status: ready to run. Revision 1 (2026-11-15).**

Marco's instruction: *"I'd like to make sure services start in a specific order as well."*

This is the platform's **service dependency graph** — the item already on the work list as one of the seven whole
things still missing — now with a stated reason: a cabinet that comes back from a restart brings its services up in an
order nobody has ever declared, and when something downstream of the platform comes up too early, the cabinet looks
broken and the alert points at the wrong component.

**Read first, and stop if the repository forbids this.** `docs/spec` is the source of truth. If any spec decision or
existing test prohibits reading, displaying or setting service start order, **stop and report it** rather than working
around it. Two of the last two briefs stopped for exactly this reason and were right to; a finding is worth more than a
tidy diff. Do not edit the spec, do not weaken or edit an existing test.

## What already exists (read these before writing anything)

- **Services are read from the cabinet.** `contracts/schemas/operations/services.list.schema.json` and the agent's
  `agent/src/Cabinet.Agent.Windows/ServicesAndProcesses.cs` produce what the console shows. Read what is already
  returned — start type, state, account, recovery — before adding anything: the new columns may already be there.
- **Recovery is already modelled, and it is dangerous in one specific way.** `server/src/services/service-recovery.ts`
  parses recovery actions (`none` / `restart` / `reboot` / `run_program`) and already groups the services whose recovery
  action is `reboot`. Its own comment says a `reboot` in any of the three slots means **one failing service can restart
  the whole cabinet**. Whatever you build, do not make that easier: a service order is not a licence to restart a
  cabinet, and nothing in this task may issue a reboot.
- **There is no services table.** Nothing about a service is stored server-side today; do not assume one exists.
- **The way a support person sees a cabinet** is the console's cabinet pages. Follow their conventions.

## The job, in order

1. **Map what is known and what is not.** For a service on a cabinet, list which of these the platform can already see:
   display name, start type (automatic / automatic-delayed / manual / disabled), running state, logon account, the
   service's **configured dependencies**, the services **depending on it**, and its recovery actions. Paste the evidence
   (file:line) for each. Anything genuinely unknown is work; anything already known is not.
2. **Read the order as data.** Windows already holds the truth: a service's dependency list and its delayed-auto flag.
   Read them and model them. **Do not invent a parallel ordering scheme that Windows does not enforce** — an order the
   console shows but Windows ignores is worse than no order at all, because it misreports the fleet.
3. **Show the effective start order for a cabinet**, in the console, so a person can answer "what comes up first on this
   cabinet, and what waits for what" without opening `services.msc` on it. Where the order cannot be determined from what
   the agent reports, the console must say *that*, not guess.
4. **Flag a cabinet whose real order contradicts what was declared** — the drift case. This is the half that pays for the
   work: a declared order that silently stopped being true is exactly how an unexplained cabinet outage happens.
5. **Allow setting the order, as a write that obeys the platform's rules.** If and only if the spec permits a write here:
   allowlisted operation, role-gated (find the tier the existing service-related writes use and match it), confirmed with
   the existing confirmation/step-up pattern, logged like every other write, and **never issued twice**. One service's
   order at a time from its own page — check how the platform treats comparable writes and match it; if comparable writes
   are fleet-wide and permitted, say so in your report and let the owner decide, do not decide it yourself.
6. **Additive migration only**, if storage is genuinely needed. Follow the existing numbering and style. Nothing
   destructive, nothing that touches a live cabinet's data.

## Rules this task must not break

- **One lifecycle owner per fleet job; never issue a change twice; a misreport of fleet state is a defect; every write is
  allowlisted, role-gated, confirmed and logged; sync-cabinet safety comes first.** These do not bend.
- Nothing in this task may restart, reboot or shut down anything. Reading a recovery action is fine; exercising it is not.
- TypeScript stays strict; server and console must both type-check clean. The agent stays `net10.0-windows`.
- No new dependency, no upgrade, no reformatting code you were not asked to change.
- **Do not touch the demo mode, the restart schedule, or the fleet job operations** — separate tasks with their own
  briefs.
- No commits. Leave everything in the working tree for review.

## Acceptance — run these and paste the exact output

Use the repository's own runner. `server/package.json:12` is `npm run build && node --test --test-concurrency=2
dist/test/*.test.js` — **there is no server Vitest**; do not invent an acceptance command, use the repo's.

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

echo "== what changed =="
git diff --stat | tail -25
git status --short

echo "== where the order is read and where it is written =="
grep -rn "depend" agent/src/Cabinet.Agent.Windows/ServicesAndProcesses.cs contracts/schemas/operations/services.list.schema.json | head -20
echo "State the file:line the agent reads dependencies from, and the file:line (if permitted) where an order is written."
```

The test database is running on this host (`127.0.0.1:11433`). If your sandbox cannot reach it, or cannot run
Windows-only agent tests (this is a Linux host — it cannot), say so plainly and name what you did not run. **Never report
a suite as passing that you did not run.**

## Report, in this order

1. The step-1 map: what is already known about a service, with file:line evidence, and what is genuinely missing.
2. Every file added and changed, each with a one-line reason; any migration with its number and why it is additive.
3. How the effective order is read — and **why that order is real**, i.e. what Windows does with it, not just what the
   console displays.
4. The drift check: what counts as drift, and the exact wording a support person sees.
5. What you found that contradicts this brief, including any spec decision or test that forbids part of it. **Say it
   plainly; do not do the forbidden part.**
6. The acceptance output verbatim, plus before/after test counts, and anything you could not run.

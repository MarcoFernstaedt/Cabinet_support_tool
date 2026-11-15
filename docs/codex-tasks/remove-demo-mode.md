# Task: remove the demo mode from the cabinet platform

**Status: ready to run. Revision 1 (2026-11-15).**

Marco's instruction: *"For the demo mode stuff it can likely go away just ensure you update ui as well."* This is a
removal task, not a refactor. The demo mode is a product surface that was built for showing the platform off; the
platform is going onto real cabinets at a satellite site and a sink cabinet this week, and the inventory should not
carry a simulator. It goes, and the console UI has to keep working without it.

## What already exists (do not rebuild any of this)

Read these before you touch anything; they are the shape of the feature you are removing.

- **Server simulator:** `server/src/demo/config.ts`, `demo.ts`, `fleet.ts`, `network.ts`, `outputs.ts`, `scenarios.ts`,
  `troubleshooting.ts` — eight files, the synthetic fleet and its scripted scenarios.
- **Server routes:** `server/src/console-api/demo-routes.ts`, registered from `server/src/console-api/server.ts`.
- **Contracts:** `contracts/schemas/console/demo-mode.schema.json` and ten examples under
  `contracts/examples/console/demo-mode/` (`valid/off.json`, `valid/on.json`, `valid/reset.json`, six `invalid/*.json`).
- **Console UI:** `console/src/components/DemoBanner.tsx`, `console/src/components/DemoTour.tsx`,
  `console/src/pages/DemoGuide.tsx`, `console/src/pages/admin/DemoMode.tsx`, plus their entries in
  `console/src/App.tsx` (routes), `console/src/components/Layout.tsx` (navigation), and `console/src/styles.css`.
- **Tests:** `server/test/demo.test.ts`, `demo-reset.test.ts`, `demo-simulator.test.ts`,
  `console-demo-e2e.test.ts`, `console-guided-demo-e2e.test.ts`.
- **Docs:** `docs/platform/demo.md`.
- **Roughly 48 further files** mention `demo` somewhere — some are real wiring you must unpick
  (`server/src/contracts.ts`, `server/src/db/json-columns.ts`, `server/src/db/table-owners.ts`, `server/src/main.ts`,
  `server/src/console-api/crash-routes.ts`, `setup-routes.ts`) and many are incidental mentions in services and pages
  that must be left alone. Work out which is which by reading, not by a global search-and-replace.

## The job, in order

1. **Map the feature first.** Produce the complete list of files that exist *for* the demo mode and the complete list of
   places production code *branches on* it (a `isDemo(...)` test, a `demoMode` flag read from config, a conditional route
   registration, a table owner, a JSON column). Paste both lists into your report. Do not start deleting before both are
   in front of you.
2. **Remove the server side.** Delete the eight `server/src/demo/` files and `demo-routes.ts`; unregister the routes from
   `server.ts`; remove the demo entries from `contracts.ts`, `json-columns.ts` and `table-owners.ts`; delete the five demo
   test files.
3. **Remove the contracts.** Delete `demo-mode.schema.json` and the `contracts/examples/console/demo-mode/` tree, and
   whatever line in the contract index or generator names them. Follow the repository's own contract layout — if the
   schemas are referenced from an index, a manifest or a test that walks the directory, update that too.
4. **Remove the console UI and repair the UI around it.** Delete `DemoBanner.tsx`, `DemoTour.tsx`, `DemoGuide.tsx` and
   `admin/DemoMode.tsx`. Remove their routes, their navigation entries, their admin links, their CSS, and every
   conditional that showed a banner, a badge or a tooltip because demo mode was on. The result must be a console with no
   demo affordance anywhere and no dangling import.
5. **Delete `docs/platform/demo.md`** and any sentence in another document that tells a reader how to switch demo mode on.
6. **Leave the database alone.** Do **not** write a migration that drops demo tables or demo columns, and do not touch
   `server/migrations/`. Removing code is reversible in review; a migration that drops data lands on live cabinets. If
   demo tables exist, name them in your report as a follow-up decision instead.

## Rules this task must not break

- `docs/spec` is the source of truth. If a spec sentence describes the demo mode as a feature, say so in your report; do
  not edit the spec for this task (the owner will reconcile it).
- The sync-cabinet safety rule, the writes-allowlisted rule and the one-lifecycle-owner-per-fleet-job rule are invariant.
  Nothing in this task may touch them.
- **Do not weaken or edit any existing test that is not a demo test.** If removing the demo mode makes a non-demo test
  fail, that is a real finding: stop, leave it failing, and explain it in your report. A changed assertion in a test you
  were not asked to touch is a defect in your change.
- Do not add a dependency, do not upgrade anything, and do not reformat code you are not deleting.
- TypeScript stays strict. The console and server must both still type-check.

## Not in this task

- No refactoring of the surrounding services "while you are there".
- No new features, no new tests beyond deleting the demo ones.
- No changes to `server/migrations/`, no schema changes, no data changes.
- Do not touch `console/src/components/WelcomeTour.tsx` or `console/src/lib/spotlight.ts` **unless** you can show they
  exist only to serve demo mode. A first-run welcome tour is a different feature from a demo simulator; if it survives
  the removal cleanly, it stays, and you say so in the report.
- No commits. Leave everything in the working tree for review.

## Acceptance — run these and paste the exact output

Run from the repository root. Logs and any scratch files go to `/home/marco/.hermes/cache/scratch/demo-removal/`;
create no file or directory inside the repository other than the deletions this task names.

```sh
cd /home/marco/cabinet_support_tool

echo "== the simulator is gone =="
ls server/src/demo 2>&1 | head -3
echo "demo routes: $(ls server/src/console-api/demo-routes.ts 2>&1)"
echo "demo schema: $(ls contracts/schemas/console/demo-mode.schema.json 2>&1)"
echo "demo examples: $(ls -d contracts/examples/console/demo-mode 2>&1)"
echo "demo doc: $(ls docs/platform/demo.md 2>&1)"
echo "demo tests: $(git ls-files 'server/test/*demo*' | wc -l)   (expect 0)"
echo "demo-named files still tracked: $(git ls-files | grep -ci demo)   (expect 0)"

echo "== nothing still imports it =="
grep -rn "src/demo/\|demo-routes\|DemoBanner\|DemoTour\|DemoGuide\|DemoMode\|demoMode\|isDemo" console/src server/src --include=*.ts --include=*.tsx | head -20
echo "(expect no hits above)"

echo "== the trees still build and type-check =="
cd server && npx tsc --noEmit && echo "server tsc OK"
cd ../console && npx tsc --noEmit && echo "console tsc OK"

echo "== the suites =="
cd /home/marco/cabinet_support_tool/console && npx vitest run 2>&1 | tail -15
cd /home/marco/cabinet_support_tool/server && npx vitest run --reporter=basic 2>&1 | tail -25

echo "== the working tree contains only this change =="
cd /home/marco/cabinet_support_tool && git status --short
```

## Baselines to compare against (measured before you start, 2026-11-15)

- Console: **29** test files, all green.
- Server: **1089** passing, 0 failing, 10 skipped. Demo tests are part of that count and are expected to disappear with
  the feature; every *other* test must still pass, and no other test file may be edited.
- Console type-check clean, server type-check clean.

An acceptance block that ends with fewer green tests than the baseline minus the demo tests is a failure, not a result.
Report the before/after counts explicitly.

## Report, in this order

1. The two lists from step 1 (files that exist for the demo mode; production branches on it).
2. Every file deleted, and every file edited, with a one-line reason each.
3. The acceptance output, verbatim, plus the before/after test counts.
4. Anything you found that contradicts this brief — a demo table, a spec sentence, a feature that turned out to be
   demo-only, a production path that only worked because demo mode filled it in. Findings here are worth more than a
   tidy diff.
5. What you deliberately did not touch, and why.

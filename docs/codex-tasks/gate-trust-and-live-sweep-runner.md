# Gate trust, and a runner for the live sweep

**Branch: this work is dispatched against `feat/remote-access-tunnel` (the development branch). Do not touch `main`.**
Do not commit: leave the changes in the working tree.

## Why

Three things stop this repo from proving its own state, and one gap stops a real deployment from being
repeatable. The owner's instruction for this round: *have Codex do as much as possible.*

## What already exists (read these, do not re-invent them)

- `platform-contracts.yml:54` already installs a browser (`npx playwright install --with-deps chromium`), so the
  workflow is not the browser problem. The browser problem is *local*: a full suite run inside a bare `node:22`
  container fails 37 console e2e cases for want of a Chromium binary, and 1 more fails on `git`'s dubious-ownership
  check as root. Those 38 are environmental and are what the owner's records call "the 38 baseline failures".
- CI runs again (the repo has been public since 2026-11-20 and Actions runs on free minutes). Runs of 2026-11-21:
  `agent-windows` failed on the retired development shell's own Windows tests — those files are **already deleted on
  this branch**, so that red cannot recur here; `contracts-server-agent` failed on the flake in item 1. The billing
  claim in the docs is dead text.
- `docs/platform/remaining-phases.md:546` already records the flake's history in the project's own words:
  "`troubleshooting.test.ts` failed 8 times in one full run at `--test-concurrency=2`".

## The numbered job

1. **Fix the demo suite's timing flake.** Observed on CI run 44906438960, job `contracts-server-agent`:

   ```
   not ok 416 - time: wrong zones and a drifting clock raise alerts; Tier 1 corrects them and the alerts close; Tier 2 sets a site's zone
     duration_ms: 10261.203741
     location: '.../server/dist/test/demo.test.js:306:1'
     error: 'timed out waiting for the zone alert to close'
     code: 'ERR_ASSERTION'
     stack: until (server/dist/test/demo.test.js:83:12)
   ```

   The suite waits on a poll (`until`) for an alert to close and the wait is lossy — the test asserts on a race, not on
   the product. Find the underlying ordering the open/close path depends on and make the test wait on the *signal*
   rather than on a wall-clock window. This same shape is what has been failing one job per run on this repo since
   2026-11-01. Fix it in the source under `server/src` or the test under `server/test` — whichever owns the race — and
   say in your report which side you fixed and why that side.

   **Acceptance:** run the suite the way CI does, repeatedly, and paste the counts:

   ```
   cd server && npm run build
   for i in 1 2 3; do node --test --test-concurrency=2 dist/test/demo.test.js | grep -E '^# (pass|fail|tests)'; done
   ```

   It is fixed only when three consecutive runs print `# fail 0`.

2. **Correct the two live documents that still claim Actions are disabled.** Exact lines, verified 2026-11-21:

   - `docs/platform/remaining-phases.md:84` — "**CI:** GitHub Actions are on hold for billing, so its checks are red on every PR and say nothing either way."
   - `docs/platform/decision-log.md:4315` — "While GitHub Actions cannot run (account billing), it can only be proven on a…"

   Replace the claim with the truth: Actions runs (public repository, free minutes), and the decision text must not
   assert a billing block. **Leave the dated `docs/codex-tasks/*.md` files alone** — those are historical task records
   and rewriting them would falsify the record.

3. **Make the local container run tell the truth.** A full local suite run needs two provisions that no document
   states. Add them where a person running the suite will find them — a short section in the testing documentation plus,
   if a script already exists for a full suite run, the two lines in it: install a Chromium for Playwright's use, and
   `git config --global --add safe.directory <repo>` before running as root. Do not add a new CI job, and do not silence
   any test: the point is that a container run can be made equal to CI, or the difference is written down.

4. **Add the live-cabinet acceptance runner the deployment needs.** New file `scripts/acceptance/live-cabinet-sweep.mjs`.
   Plain Node, no new dependencies, and it takes everything from the environment —
   `CABINET_PLATFORM_URL`, `CABINET_ADMIN_USER`, `CABINET_ADMIN_PASSWORD`, `CABINET_CABINET_ID` — **never a literal
   credential, token or address in the file.** It must:

   - sign in to the console API and issue each of these operations against the cabinet, one at a time, waiting for the
     agent's result: `services.list`, `processes.list`, `eventlog.get`, `drivers.list`, `storage.volumes`,
     `storage.physicalDisks`, `network.adapters`, `hardware.summary`, `database.connectivity`, `service.control`,
     `service.setStartType`, `process.end`, `firewall.status`, `updates.status`, `boot.config` (this one is expected to
     be an unknown-operation refusal, and that is a *pass*);
   - print one line per check as `PASS <operation> <what was asserted>` or `FAIL <operation> <why>`, followed by a final
     line `# pass N` and `# fail M` that a `grep -E '^# (pass|fail)'` recovers exactly;
   - treat a *refusal* as a pass only when the refusal message is what the product's own rules predict — an operation the
     cabinet's approved list does not cover must be refused with the sentence naming the list, and a read-only cabinet
     must refuse writes naming read-only. Assert on the message, not on the word "refused";
   - write its per-check verdicts as JSON beside the log, named from a `--out` flag.

   This runner will be run by hand against a real cabinet; it must not attempt to install anything, and it must not
   assume it is the only client.

## Rules this task must not break

- `docs/spec/` is the source of truth and is not edited here.
- No migrations, no schema changes, and no new dependency.
- Do not revive anything named `ShellCabinet` or any console/operator shell path: that surface was deliberately removed
  on this branch.
- Do not add a CI status badge, and do not modify `platform-contracts.yml`'s trigger set.

## Not in this task

- Any fix in the product's own features (the owner's next round covers those).
- `main`, the deploy scripts, and the release pipeline.
- The 108 cross-module writes and the rest of the scale-out list.

## What to report

Paste, exactly: the three `# pass`/`# fail` lines from item 1's acceptance block; the diff hunks for the two document
lines; the path of the new runner and the output of `node --check` on it; and the two provisions you added for item 3.
List every file you touched. If something in this brief could not be done, say which item and why — do not substitute a
different change for it.

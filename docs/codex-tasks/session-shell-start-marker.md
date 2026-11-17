# Acceptance: distinguish "never ran" from "ran and lost its output"

Measured on the real cabinet (`C:\repro\repro-driver.log`, two runs): a PowerShell child that
exits from a `catch` loses the tail of its output, marker included, and the console then goes
silent. A child that exits normally delivers its marker. The acceptance currently waits for a
`DONE_`/`FAIL_` marker and, when none arrives, reports a timeout — `Timed out: off-network
whoami`. That reads output loss as non-execution, and it is how the entire "third command
never runs" investigation was framed.

## What to change in `scripts/acceptance/session-shell-cabinet.mjs`

**Keep every existing assertion exactly as it is.** Do not relax, skip, or re-scope a check.
Add a per-command *start* marker to the typed wrapper, flushed before the work begins, so the
three outcomes are separable:

- `START_<id>` arrives, `DONE_<id>`/`FAIL_<id>` arrives = ran, finished, with the outcome.
- `START_<id>` arrives, no outcome = **"started, no outcome received"** — the child ran and its
  tail was lost. This is a distinct, reportable result, not a timeout.
- No marker at all = **"execution unconfirmed"** — this is the only case the old timeout
  description was correct for.

The wrapper must flush stdout and stderr after each marker and settle briefly before exiting on
**both** paths, success and catch, so a normal command's marker cannot be lost with the dying
child.

Make the new distinction visible in the run output and in the evidence the harness prints, so a
human reading a red run can tell which of the three happened for each check.

## Not in this task

- Do not touch the product or the agent. This is the test's reading of the result, nothing else.
- Do not commit. Leave changes in the working tree.
- Dev branch only: `feat/remote-access-tunnel`, never `main`.

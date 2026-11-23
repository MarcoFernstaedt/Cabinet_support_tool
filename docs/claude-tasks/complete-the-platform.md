# Everything that is left, for Claude Code

**Written 2026-11-23 by Aster, for the owner (Marco).** This is the single file to hand the builder: the state, the
rules, and every remaining piece of work with what proves it. It is written so a builder can start on any item
without another survey.

**Read these first, in this order:**

1. `docs/spec/STANDING-INSTRUCTIONS.md` — the spec is the source of truth, and *"if the spec does not answer
   something, stop and ask rather than guessing"*. That rule has already stopped two runs for the right reason.
2. `docs/platform/remaining-phases.md` — the count. Its F1–F23 table is the item list; its "Verified against the
   source, 2026-11-15" table (12 rows, four independent passes) is the state of each item, with the deciding line
   quoted. Anchors quoted in this file come from that table: **re-read the line before building on it.**
3. `docs/platform/decision-log.md` — every decision that narrows the work, by number. Several items below are
   explicitly refused by a decision; do not reopen one silently.
4. `docs/spec/09-open-decisions.md` — the owner's standing decisions, including *no bulk restarts* and *firmware is
   detect-alert-hand-to-a-human*.

## The state, 2026-11-23

| Thing | Where it is |
|---|---|
| Branch under test | `feat/remote-access-tunnel` (the dev branch), now **level with `main`** at `607ff65d` |
| `main` | `e8cd887a` |
| Deployed agent release | **0.3.1**, signed with our internal publisher CA; the lab's update store serves it |
| The one real cabinet | Marco's HP, `deviceb` (tailnet `100.69.163.20`, ssh alias `deviceb`), online as `DEVICEB-real`, agent **0.3.1**, read-write, both services Running |
| The lab platform | `cabinetlab-server` (docker), console plain HTTP on `100.119.218.113:9443`, agent API HTTPS on `:9444`, DB `cabinetlab` |
| The live platform | `cabinet-server-1` (docker) on the VPS, agent API on public `8443`, DB `cabinet` |
| CI | GitHub Actions, free minutes (the repo is public). Two jobs: `agent-windows`, `contracts-server-agent` |
| Open PRs | **none.** #337 (merge `main` into the dev branch) was closed as superseded once the merge landed on the branch at `607ff65d` |

**Two lines of development.** `main` never receives dev-only code. The dev branch may run at a lowered security
posture where that buys a working instrument, but any relaxed capability stays config-gated and audited. The
remote-access tunnel is the dev-only feature; it must not reach a released agent.

## The rules this repository is held to

- **One finding or requirement per PR.** Each carries a decision-log entry (numbers are **not** reusable — `main`
  and the dev branch have both used 132–140) and a test that fails without the change.
- **A PR states its own local full run** (`# tests / # pass / # fail / # skipped`), not a filtered grep.
- **Commit before you measure.** The gate grades the checkout and prints `[reviewed head]`.
- **Never a hand-typed acceptance.** Every acceptance is a committed script run by a runner.
- **Do not report a green you did not run.** A suite verdict comes from its own summary line; a gate verdict from
  its exit status.
- **Findings go on the PR**, one comment, verdict in words ("Verdict: merge — no blocking findings").
- **Drift is not an alert** (decision D48). Drift surfaces on the Baseline tab and in health; only the owner can
  create a new alert policy.
- **The spec's noes stand until the owner reverses them in writing:** no ad-hoc bulk restarts, no firmware
  flashing, no bulk fleet restart button. Scheduled restarts were reopened *narrowly* — see item 11.

## The box, and how to run anything on it

```
# the disposable test database the suites want (never the live one)
docker run -d --name cab-test-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='<dev-only>' \
  -p 127.0.0.1:11433:1433 'mcr.microsoft.com/mssql/server:2022-CU27-GDR1-ubuntu-22.04@sha256:cf8f…'  # digest: docker inspect cabinet-mssql-1
SA=$(docker inspect cab-test-mssql --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MSSQL_SA_PASSWORD=//p')
export TEST_DATABASE_ADMIN_URL="sqlserver://sa:${SA}@127.0.0.1:11433/master?trustServerCertificate=true"

# the gate: two arguments, verdict from its exit status
bash /home/marco/.hermes/scripts/gate-run.sh <a-worktree-at-the-commit> <logfile>
```

- The gate needs a **detached worktree at the reviewed commit** and a clean `origin/main` worktree as its `$MAIN`.
  Never run it in the branch checkout.
- A fresh worktree has no `node_modules`. Copy them in, and resolve the three known module defects (`@types/node`,
  exact `playwright-core` version, a bare `ajv` import in `contracts/load.d.mts`) — details in the platform-ops
  skill's `references/server-suite-testing.md`. A red run must name its primary failure.
- The server suite wants `--test-concurrency=2` and an explicit `--test-timeout` (`npm test` is not that
  invocation; two browser e2e files hang without a timeout).
- Two suites at once on this two-core host flake. One run at a time.
- **Everything written here was measured with real commands.** Nothing in this file is a plan for later.

---

# The work, in the order it earns its proof

## 1. The repo cannot yet say whether it is green — do this first

Everything else is unprovable while this is true.

- **1a. A clean full run.** The gate on the merged dev head (`607ff65d`) and on `main`. Expected residue, both
  environmental and both named: 37 console e2e cases fail without a Chromium binary, and one fails with `git`
  "dubious ownership" when the suite runs as root. *Proves it:* a summary line with 0 failures and 0 skips that
  are not named, or every remaining failure written down as a skip with its reason.
- **1b. Ten consecutive green CI runs on `main`.** The reds rotate one job per run. `agent-windows` has failed on
  the retired development shell's own Windows tests, `contracts-server-agent` on a timing assertion in
  `demo.test.js`. Neither is in the file the run belonged to. *Proves it:* `gh run list --branch main` showing ten
  consecutive `success`. *Already landed:* the demo suite's race is fixed on the dev branch (`a01e71e5`, verified
  19/19 on three consecutive runs) — that is the fix; it still owes a CI run that shows it.
- **1c. The runner provides a browser.** `platform-contracts.yml:54` installs Chromium; the local container path
  needs the same, plus the repository in `safe.directory` for root. *Proves it:* the local count is 0.
- **1d. No live doc claims Actions are "on hold for billing".** That was false; the repo is public and runs on
  free minutes. *State:* already true on the dev branch — the claim is gone from
  `docs/platform/remaining-phases.md` and `docs/platform/decision-log.md`. The only surviving mentions are inside
  two old briefs in `docs/codex-tasks/`, which quote it while describing the fix; leave them.

## 2. Fleet incident correlation — the owner's top ask

Marco, 2026-11-15: *"not 20 different alerts, but how many sites and cabinets are affected, any commonalities,
common errors, if an error occurs is it tied to anything — like a proper system."*

The engine exists: `crashes.ts` builds the affected set and compares it against `unaffectedCount`,
`crash-clusters.ts` opens a fleet pattern at `CLUSTER_CABINETS = 2`, `fleet-patterns.ts` holds the patterns.
**What is missing is the aggregation on top of it**: one incident showing the number of sites and cabinets it
touches, the attributes they share, the errors that accompany it, and what it is tied to — as one thing, not a
list an operator joins by hand. Item **#27** in the count.

*Proves it:* a console view with a seeded fleet that shares exactly one attribute, and a server test that fails if
the shared-attribute computation is removed.

## 3. Drives and the failure prediction the owner actually asked for

Marco's priority, in his words: alerts from error logs with hardware first — hard drives especially — and from
that, long term, an algorithm that says when a drive will fail so replacements ship before a cabinet goes down.

Built: the drive risk class, Admin-set thresholds, `/api/fleet/drives-at-risk`, `DriveTrends.tsx`,
`trends.ts:81`. Missing around it: **correlation with crashes** (a cabinet that blue-screens and has a degrading
drive) and **NVMe counters**. *Proves it:* the correlation as a test over seeded readings, and the counters as a
named reading with its row-per-cabinet-per-day cost stated against the capacity budget.

## 4. Daily health snapshot, and the reports that exist only in the spec

Missing whole (row 19). No `Health` member in `EventKind` (`Envelopes.cs:42`), so the daily health event cannot
even be sent; no one-snapshot-per-cabinet-per-day table; no daily or weekly report — the only report route today
is a person's own case notes (`report-routes.ts:8`); and no delivery channel (no SMTP, no webhook).

*Proves it:* a snapshot table with a per-cabinet-per-day uniqueness constraint and a test that a second snapshot
in a day is refused, plus the exception report assembled from it. **Decide the delivery channel with the owner
before building it** — that is a purchase or an integration, not a code choice.

## 5. Modules with no code at all (rows 6, 7, 9, 14, 20)

Each has a named file, a named operation and a stated reason, so none needs a survey first. All are
agent-side **and** contract-side; check `contracts/schemas` is updated in the same change
(`references/acceptance-is-not-the-gate.md` — a new wire message needs three places).

- **5a. Process signer and parent (row 6).** `processes.list` is `additionalProperties: false` with neither field
  (`processes.list.schema.json:24-37`); `ServicesAndProcesses.cs:221-226` reads neither. The signing primitive
  exists for packages (`WinVerifyTrust`, `PackagePlatform.cs:114`) and must be reused, not reinvented. Careful:
  `filefacts-ingest.ts:41` has a `signatureStatus` for files on disk — that is not a process.
- **5b. Service dependency graph (row 7).** The WMI query selects no dependency field
  (`ServicesAndProcesses.cs:26`); `ServiceController.DependentServices`/`ServicesDependedOn` are never called
  (`:48-68`). **Read-only: display the effective order and report drift.** Whether the platform may *set* a
  service's dependencies is an open owner question — the spec defines no operation for it, so it needs a decision
  before it needs a contract. Do not build the write.
- **5c. Boot configuration and WinRE (row 9).** `boot.history` reads past starts only (`BootHistory.cs:7-19`).
  `bcdedit`, `BcdStore`, `WinRE`, `winre.wim`, `reagentc`, `BootNext` appear nowhere in code. Note
  `system.hardware` already carries `LastBootUpTime` — the last start, not the next boot.
- **5d. WER crash mining (row 14).** `crash.list` reads `%SystemRoot%\Minidump` and `MEMORY.DMP` only
  (`CrashOperations.cs:20-22,33-34`); `ReportQueue`, `ReportArchive`, `Report.wer`, `Windows\WER` appear nowhere.
  There is a baseline mechanism waiting for it (`15-baselines-and-config.md:16`, `services` keyed `service:<name>`)
  — use it rather than inventing a store.
- **5e. Per-model scanner profiles (row 20).** Scanners are found by USB hardware ID or the Biometric class
  (`ScannerChecklist.cs:79-92`); a scanner choice is one service plus hardware IDs
  (`client-scanner.ts:20-23`). No model field, middleware list or port list anywhere. **Collect the real models
  and ports from the fleet before building the schema** — a guessed list is worse than none.

## 6. Windows updates: install, and fleet compliance (rows 15, 16)

- **6a. `updates.install` (row 15).** Missing whole: the catalogue ends at `updates.uninstall` (`Catalog.cs:46`,
  `catalog.json:15,35`), there is no `updates.install.schema.json`, and no `IUpdateDownloader`/`IUpdateInstaller`
  anywhere. The agent's own signed self-update (`Upgrades.cs`) is a different feature and is not evidence.
  **Marco must first cut row 12 (Windows Update) into a finding** — check/install/defer are his call. Do not build
  install before that finding exists.
- **6b. Fleet update compliance (row 16, partial).** Built: the readings search matches installed hotfix IDs
  (`readings.ts:88-92`) so "who has KB X" works, plus two-cabinet comparison (`compare.ts:82-86`). Missing:
  anything that says which cabinets are *behind* or lack a named patch; `updates.status` is not searchable.
  *Proves it:* a fleet view answering "which cabinets are behind" from stored readings, with a test over a seeded
  fleet.

## 7. Agent health and driver lifecycle (rows 23, 24)

- **7a. Agent health (row 23, partial).** Built: version per cabinet, who is behind a release, who failed at
  which check, per-cabinet crash history. Missing: **an operator-invoked restart**. Note the design: the agent
  restarts itself only on a crash (SCM failure-recovery, `Install-CabinetAgent.ps1:318`) or during an upgrade, and
  `service.control` refuses the agent's own services by design (`ServiceRules.cs:38-40`). Do not defeat that
  refusal; add the operator path beside it.
- **7b. Driver lifecycle (row 24, partial).** Built: inventory with signer and version, fleet drift keyed on
  `provider|originalName`, `driver.uninstall` via pnputil with confirm-by-code, signed package install. Missing:
  package repair (the MSI path runs `/i` only, no `/f`), an MSI/software uninstall, and **canary rollouts for
  packages** — the staged-rollout machinery is agent-version-only (`rollouts.ts:1-7`, `0001_baseline.sql:569-606`).
- **7c. The owner's separate ask:** a driver that has **vanished** from Device Manager should raise an alert. The
  platform today reads devices that *report a problem*; a device that is gone is different. Establish what
  already fires for a missing device, then bring the alert question to the owner with the D48 precedent. Do not
  build an alert policy on a guess.

## 8. Site readiness (row 18, partial)

Built: a per-cabinet on-demand checklist over the read operations with "X of N passed" (`checks.ts:21-76`,
`LiveCheck.tsx:13`), and "unknown is never healthy" at cabinet level (`cabinet-health.ts:3,28-29`). Missing: the
per-site assembly, an explicit readiness verdict, and any schedule.

## 9. Approved programs: the list arrives, the authoring is the gap

Settled by measurement on the real cabinet: the platform **does** deliver the list — every heartbeat carries
`approvedApps.entries`, and only the signed half is version-gated (agent ≥ `0.3.0-0`).

The gap found on 2026-11-23, on the real cabinet: the console's approved-programs flow accepted entries the agent
then **refused**, because the agent matches a service on its key name *and* on the program it actually runs. The
refusals were correct and precise ("WSearch is not on this cabinet's approved list, so the agent will not start,
stop or restart it"; "the agent never changes CabinetAgentNetwork"; "the service is disabled…"; "no service has
that key name (display names are not accepted)"). So the product refuses safely — and a person can still author a
list that silently approves nothing.

- **9a.** Make the authoring path tell the truth: an entry the cabinet can never match is flagged when it is
  written, or the console explains the match rule (key name plus the running program) where a person types it.
- **9b.** Signing keys are still empty (`contracts/trust/approved-list/approved-list-keys.json`), so no list can
  be signed and the trust policy applies unsigned lists. Generating the Admin keypair and compiling the public
  half into the agent build is an **operator/build step**, not code.
- **9c.** Re-run the nine control checks that the lab cabinet refused under agent 0.1.2 — it now runs 0.3.1.
  Evidence lives under `/home/marco/cabinet-audit/lab64/logs/`.

## 10. Scale-out and the table-ownership debt (F21)

- F21.R4: the remaining fleet-wide views must read aggregates, never raw sample scans, measured at 10,000
  cabinets. Two are done (the kinds of blue screen, the readings search); the rest are left to measure.
- F21.R5: the documented path to per-client databases is done; the connection resolved per client is left.
- F21.R2 debt: the ratchet is written and enforced (`server/src/db/table-owners.ts`), and the tracker's count is
  stale. **Count the offenders from the code, not from the tracker**, then pay them down biggest-first. This can
  stop at any point without leaving anything broken.
- Split the monoliths when touching them: `services/alerts.ts` 70 KB, `demo/demo.ts` 53 KB,
  `agent-api/server.ts` 52 KB, `AgentConnection.cs` 51 KB, `diagnose/cabinet-findings.ts` 51 KB.

## 11. Scheduled reboots — spec first, then two PRs

The owner reopened *"No bulk restarts"* **narrowly**: a scheduled restart window, per site or per cabinet, and
nothing else. What does not change: `system.restart` stays out of `JOB_OPERATIONS`, the contract still refuses it
as a fleet job, and `server/test/fleet-jobs-no-restart.test.ts` stays green and unedited because its meaning is
*no ad-hoc bulk restarts*.

The spec amendment is already in `09-open-decisions.md` under the narrowed paragraph. **Four things must exist in
writing before code:** the window and its cap on simultaneous restarts, the confirmation bound to the parameters,
the audit trail, and what happens when a cabinet does not come back. Ordering is **per satellite behind its own
sync cabinet** — a site may have several sync cabinets (`services/sync-cabinets.ts:3`), each satellite naming its
own via `sync_cabinet_id`.

## 12. Power management off on every cabinet, with a baseline

Marco: ports must not sleep, it "sometimes flips", and the agent should hold a baseline "so it keeps it off".
`power.status` already reads the plan, Fast Startup, hibernation and USB settings — **verify whether it covers
per-device power management (the "allow the computer to turn off this device to save power" setting) before
promising anything.** The missing half is the baseline so a flip is visible. Drift surfaces on the Baseline tab
and in health, **not** as an alert (D48).

## 13. The open issues

`gh issue list --state open`: #297 (load shed hides the heartbeat: only the command poll gets the retryable
answer), #291 (`console-guided-demo-e2e` unreliable inside the gate), #289 (carry `replacesCabinetId` through the
CLI approval path, or refuse it there), #288 (cover the enrollment chain check with a test), #56 (require explicit
reapproval for cabinet read grants after staff or cabinet reactivation), #41 (retire cabinet-to-cabinet ping and
show read-only firewall configuration), #39 (fresh-enroll a cabinet and deliver actual scoped web readings —
largely superseded by the real deployment on 2026-11-23; re-read it before working it).

## 14. Deployment — the owner's deadline, and where the proof finally comes from

**Nothing is in the field.** The live platform has one site (Scottsdale) and one cabinet, status `removed`. The
satellite site and sink cabinet that Marco put first on 2026-11-15 have not been deployed. That is the single
largest gap between "the platform is built" and "the product is running", and every item in sections 5 to 8 only
earns its proof against real cabinets.

- **14a. One finding, high value, found by probing on 2026-11-23:** the live platform's **public 8443 presents a
  certificate issued by "Mashura Cabinet Platform DEVELOPMENT ONLY issuing CA"**. Field cabinets must not be
  pointed at it until that is a real certificate covering the address they dial.
- **14b.** Deploy the dev branch build as the single running platform on the VPS, then deploy a real site and its
  sink cabinet, then run the read and write sweeps against them with a committed runner
  (`scripts/acceptance/live-cabinet-sweep.mjs` is the env-driven runner; extend it, do not hand-type commands).
- **14c.** One observed agent **upgrade** end to end on a real cabinet (release `0.3.1` is in the lab's store and
  the agent is already 0.3.1, so an upgrade needs the next release), and Windows accepting the installed publisher
  root. Then F20's smoke test per Windows build family.
- **14d.** A machine running 32-bit Windows, for the sweeps against the 11.0.0 dependencies. Marco has one.

## 15. Items that need the owner, or money — do not start these

| Item | Needs |
|---|---|
| Windows Update (row 12) cut into a finding | Marco |
| Is our own remote access (F22) unparked? | Marco |
| A real release-signing certificate — releases still ship on the development key | purchase |
| TPM-held agent keys — the agent's key is in the software store | purchase |
| An independent penetration test | purchase |
| BIOS/firmware flashing | skipped by the owner, 2026-11-15 — detect, alert, hand to a human |
| Motherboard re-imaging | needs its own spec before it is an item |

## 16. Known-environmental, so a run is never clean

State these in any PR rather than "fixing" them: 37 console e2e cases need a Chromium the runner may not have; one
test fails on `git` "dubious ownership" when the suite runs as root; the 18 skips are named in each run and recur
for the same reasons — `TEST_AGENT_DLL` (the agent does not build here with NuGet revocation on) and PowerShell 7.
Take the reasons from the run's own output; do not carry a count forward from this file.

## Start here

**No PR is open.** #337 proposed merging `main` into the dev branch; the merge landed on the branch at `607ff65d`
(dev now level with `main` at `e8cd887a`) and #337 was closed as superseded. Work the list above from item 1.

## What "done" means here

No item is done until its "proves it" holds and its numbers were actually run. A green suite you did not run, a
capability you asserted without quoting the line that decides it, and a count taken from a stale tracker are all
the same failure — and this project has already paid for each of them twice.

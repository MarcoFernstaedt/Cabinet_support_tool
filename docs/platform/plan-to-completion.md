# Plan to completion

Written 2026-11-23, at `main` `e8cd887` and the development branch `feat/remote-access-tunnel` `d200265`. Every remaining piece
of work, in the order it is built, with where it lives, what proves it, and its size in PRs. Sizes are worked out from the code,
not measured. The choices each item builds to are in the decision log (D141 to D144); the spec's open decisions file says which
are decided.

The rules stay the repository's own (CONTRIBUTING.md, CLAUDE.md):
- one finding or requirement per PR;
- a decision-log entry and a test that fails without the change;
- the local full run stated in each PR;
- `main` never receives development-only code.

## Where it stands

**The audit of 2026-11-23** (static, over `main` and the development branch):
- **Programs are started only one way.** On the agent that is `ExternalProgram.Run`: 11 named System32 programs, an argument array,
  no shell. The other is the updater, started by full path with one fixed verb.
- **The broker opens no network connection.** The network service runs as `NT SERVICE\CabinetAgentNetwork`, not as an administrator.
- **Nothing reads the Security log or the cabinet application's database.** Symptom rules use no regular expressions, and no secret
  is in the tree.
- **222 console routes:** each checks the person's role on the server, except three meant to be open: health, the console's own
  files, and the installer download, which checks the site token instead.
- **Every state change** must come from the console's origin (`server/src/console-api/server.ts:120`).
- **Fleet jobs and rollouts** (`fleet-jobs.ts`, `rollouts.ts`) read correctly against their spec:
  - one site per job, sync cabinets last and only after every satellite checked out;
  - the role re-read before each batch, and the per-cabinet answer budget;
  - recovery under the job's lease;
  - the rollout's batches, its automatic pause, and the offline skip.
- **One gap found:** the server has no production issuing key (`server/src/runtime.ts:11`). That is item 3.1.
- **One nit, not a defect:** a cabinet ID sent in upper case is refused as "does not exist" (`fleet-jobs.ts:92`), because IDs are
  compared in lower case. The console always sends lower case.

**The full local gate** (`main` and the development branch) is in the PR that added this file (#338). The history of the count
before this plan, `remaining-phases.md`, was folded in here on 2026-11-25 (D150); git history keeps it.

**Already closed, so not listed below:**
- F21.R2 (the debt is 0, D129).
- The 2026-11-13 fleet audit.
- F21.R5's second half (one database, D141).
- The code-signing purchase (our own root, D143).
- The development shell (retired on the development branch).
- The 38 local failures, which were the environment's: Chromium, and git's ownership check as root.
- Service dependencies are read (#271): the graph is shown.

## 1. Prove the repository is green (first, about 3 PRs, 2 to 3 days)

| # | Work | Proves it |
|---|---|---|
| 1.1 | **Done** (#340, D145). Bring the demo suite's race fix (`a01e71e` on the development branch) to `main` | `demo.test.js` green three runs running |
| 1.2 | **Done** (#339, D146). Remove the "on hold for billing" claim from `main`'s live documents | no live document says Actions are on hold |
| 1.3 | In #342 (D148). Write down the local environment the suite needs (Chromium, git `safe.directory`) where a run finds it | a local run with 0 failures and every skip named |
| 1.4 | Ten consecutive green runs on `main` (4 so far) | `gh run list --branch main` |
| 1.5 | `same-error-elsewhere.test.ts` test 927 fails one CI run in some PRs with "database is in transition" (#340, #342). Not reproduced locally; needs the full error text, then a fix a test proves | the failure's cause named and fixed |
| 1.6 | `scale.test.ts`'s lock case fails on a fast SQL Server: the held lock gave up at 4.4 s against a 4.5 s floor (the owner's machine, `main` too). Passes in CI and here | the floor measured, or the cause named |
| 1.7 | Sign-in under contention in `ConsoleHarness.account` (`troubleshooting.test.ts` 8 failures in one run at concurrency 2), and the suite's 19 minutes on CI: find the slow files | a cause for each |

## 2. Server work that can be built now (about 30 to 40 PRs, 1.5 to 2.5 weeks)

| # | Work | Where | Proves it | PRs |
|---|---|---|---|---|
| 2.1 | F21.R4: measure the fleet views not yet measured at 10,000 cabinets and fix any that scan raw rows | `server/test/fleet-views-at-scale.bench.ts` | the bench, and a plan or reads test per fix | 2 to 3 |
| 2.2 | F7: process and task expectations as role baseline items (D142) | `baselines`, the Differences view | a seeded cabinet whose stored answer misses an item shows the difference; the test fails without the judge | 2 to 3 |
| 2.3 | Fleet incident correlation (the owner's top ask): one incident with its sites and cabinets, the attributes they share, the errors that come with it, what it is tied to | on `crashes.ts`, `crash-clusters.ts`, `fleet-patterns.ts` | a seeded fleet sharing exactly one attribute; a test that fails without the shared-attribute step | 3 to 5 |
| 2.4 | Drives: crashes linked to degrading drives | `trends.ts`, `drives.ts` | a test over seeded readings | 1 to 2 |
| 2.5 | Fleet update compliance: which cabinets are behind, which lack a named update | `readings.ts`, `compare.ts` | a seeded fleet view test | 2 |
| 2.6 | Site readiness: the per-site assembly of the checklist, a verdict, a schedule; unknown never ready | `checks.ts`, `cabinet-health.ts` | a site with one unknown check is not ready | 2 to 3 |
| 2.7 | **Built** (D149, branch `feat/approved-entry-matches`). Approved programs: flag an entry no cabinet can match where it is written, and say the rule (key name and the running program) | console approved-programs editor | an unmatched entry is flagged | 1 to 2 |
| 2.8 | Split the largest files when they are next touched: `alerts.ts`, `demo.ts`, `agent-api/server.ts`, `cabinet-findings.ts` (and `AgentConnection.cs` in 4) | — | the gate unchanged | 4 to 5 |
| 2.9 | Open issues: #297 load shed hides the heartbeat; #291 guided demo unreliable in the gate; #289 `replacesCabinetId` in the CLI approval; #288 test the enrollment chain check; #56 re-approval after reactivation; #41 retire cabinet-to-cabinet ping. #39 is re-read first: the 2026-11-23 deployment may have closed it | per issue | a test per fix | 6 to 7 |
| 2.10 | Agent restart by an operator (D144): the server, contract and console side | `catalog.json`, console | the operation refused below Tier 2 and without its code | 1 |

## 3. Built from a decision now taken (about 10 PRs, 1 week)

| # | Work | Proves it | PRs |
|---|---|---|---|
| 3.1 | **Production issuing CA** (D143): a root-ceremony script that makes an offline root and an issuing CA, a server loader for a key file outside the repository, and the agent API's TLS certificate from it. Field cabinets wait for this | the server refuses to start in production without it; a test issues an agent certificate from a file key; the development key is still refused in production | 2 |
| 3.2 | Scheduled restarts (D144): the spec text, then the window and its runner | the order (sync first), the cap, the stop on a cabinet that does not return, all audited; `fleet-jobs-no-restart.test.ts` unchanged | 1 + 2 |
| 3.3 | Daily health snapshot and exception reports (D144): the agent's `Health` event kind, a table with one snapshot per cabinet per day, the daily and weekly exception reports in the console and as a file | a second snapshot in a day is refused; the report assembled from snapshots | 3 to 4 |
| 3.4 | Report email through the operator's mail relay (D144) | a test with a local relay | 1 |
| 3.5 | Vanished device alert (D144): a required device that disappears raises a minor alert, closed on return | seeded device readings | 1 |
| 3.6 | Power management as a baseline: first add the per-device "allow the computer to turn off this device" reading, which `power.status` does not read today (its output is the plan, Fast Startup, hibernation and USB selective suspend); then the baseline item, shown as drift (D48) | a flip shows on the Baseline tab | 2 |

## 4. Agent and contract work (about 15 to 25 PRs, 1 to 1.5 weeks to write)

Written and tested here; each is proven on a real Windows cabinet in 6. Every new wire message changes the schema, the C# and the
TypeScript in one PR.

| # | Work | PRs |
|---|---|---|
| 4.1 | Process signer and parent, reusing the package signature check (`WinVerifyTrust`) | 1 to 2 |
| 4.2 | Boot configuration and the recovery environment (WinRE), read only | 2 |
| 4.3 | Windows Error Reporting crash mining, stored through the baseline mechanism | 2 |
| 4.4 | Machine variables, secret-looking values hidden | 1 |
| 4.5 | SFC scan and DISM repair, Tier 2 with a code | 1 to 2 |
| 4.6 | Packet capture, Admin only, 60 s, one host or port | 2 |
| 4.7 | AMT / vPro detection | 1 |
| 4.8 | Agent restart by an operator, the agent half (through the broker) | 1 |
| 4.9 | Drivers and packages: repair (`msiexec /f`), uninstall a program, staged rollouts for packages | 3 |
| 4.10 | NVMe counters, with their storage cost per cabinet per day stated | 1 |
| 4.11 | `updates.install` for approved updates, staged per site, restarting only in the window (D144) | 2 to 3 |
| 4.12 | Per-model scanner profiles. First collect the real models and ports from the fleet; no guessed list | 2 |
| 4.13 | TPM-held agent keys through Windows' platform key provider (D143) | 2 |
| 4.14 | On-demand ETW tracing, last | 2 |
| 4.15 | Split `AgentConnection.cs` | 1 |

## 5. Development branch only (about 2 to 3 PRs)

| # | Work |
|---|---|
| 5.1 | A development publish path: the real four projects with the SSH transport, signed with the publisher CA, packaged by `new-agent-release.py`, put in the store. `CAB0003` stays as it is |
| 5.2 | Keep the branch level with `main` after each run of merges |

## 6. Deployment, where the proof comes from (needs the owner's machines and time)

| # | Work | Needs |
|---|---|---|
| 6.1 | The live agent API on the production issuing CA (after 3.1) | the VPS |
| 6.2 | One platform build on the VPS, then a real site with its sync cabinet; the read and write sweeps through `scripts/acceptance/live-cabinet-sweep.mjs` | a site |
| 6.3 | One agent upgrade watched end to end on a real cabinet (needs a release after 0.3.1), then F20's smoke test per Windows build family | the HP cabinet |
| 6.4 | Sweeps on 32-bit Windows | the owner's 32-bit machine |
| 6.5 | Generate the approved-list signing keys and build their public half into the agent (an operator step), then re-run the nine control checks on 0.3.1 | the operator |
| 6.6 | Prove each item of 4 on the cabinet, and mark its Windows-only tests verified | the HP cabinet |
| 6.7 | Work through the security review brief (`docs/spec/11-security-review-brief.md`) and record the findings, in place of a bought test (D143) | — |
| 6.8 | The writes not yet run on hardware: static `network.setIp`, lease release, restart and shutdown, update and driver uninstall, package install, `firewall.restore`, service and process control (needs an approved list) | the HP cabinet |
| 6.9 | Install the nightly backup on the test host (`/etc/cron.d/cabinet-backup`) and run one backup. A host task, not code | the VPS |
| 6.10 | How long Windows takes to refuse a closed TCP port in a test series. Each try gets 5 s (D1); the strict test passed once on Windows CI (job 136864014813), which is not a measured bound | the HP cabinet, or CI runs |

## 7. Not started without the owner

| Item | Why |
|---|---|
| BIOS and firmware flashing | skipped by the owner: detect, alert, hand to a human |
| Motherboard re-imaging | needs its own spec first |
| An independent penetration test | reopened only if a client requires one (D143) |

## 8. Findings outside the owner's order (not scheduled)

The owner's brief of 2026-11-07 set findings F1 to F23. On 2026-11-15 the owner reordered the work by what the fleet needs, and the
sections above follow that order. These open parts of the brief are outside it. Each waits for the owner to order it; none is
dropped. Done parts are in the decision log (D31 to D60).

| Finding | Open part | Note |
|---|---|---|
| F5 | Publishers per vendor | a publisher entry needs a real cabinet's signer |
| F7, F9 | Expected drivers; scheduled-task results | process and task expectations are 2.2 (D142); F9 is agent work |
| F10, F11, F12 | The workload's progress signal, file staleness, declared ports (F12.R3 is done) | mostly agent-side samplers |
| F13 | Process history: trends, leak and wedge, tree, holder | |
| F14 | R1 dependencies in stored configuration, R2 the blocking dependency named | read only (D144); R2 is an agent build |
| F15 | The chain under the workload: database, its error log, the monitoring agent | never the cabinet application's database |
| F16 | Scheduled, change-gated sampling for the remaining reads, inside the capacity budget | |
| F18 | R3 the watchdog | agent |
| F19 | R1 to R6: driver store against bound, matching, rollout, verification, version rollback | overlaps 4.9 |
| F20 | The update source (an agent operation) | the smoke test per build family is 6.3 |
| F21 | R2 boundary validation and idempotent writers | R4 is 2.1; R5 is closed (D141) |

The ordering rules from the brief still hold:
- Nothing that changes a cabinet ships before F1 and F2.
- Templates (F7) come before anything that needs a declared expectation.
- No new sampler ships before its rows per cabinet per day, retention and rollup are counted against the capacity budget.

## How long

At the pace since 2026-11-20 (about 5 merged PRs a day, larger features one to two days each with a review round), sections 1 to
5 are 60 to 80 PRs: **3 to 5 weeks**. Section 6 runs beside them as far as lab time allows and sets the end: **4 to 6 weeks** to a
platform that is built, deployed to a real site and proven on hardware. Nothing on this list needs a purchase.

# Phases left, and what each contains

2026-10-25. **The exact answer: 5 phases are left — roadmap phases 2, 3, 4, 5 and 6.** Two of them are part built
(phases 2 and 3); phases 4, 5 and 6 have little or nothing in them.

This is the one place the count lives. The [roadmap](13-roadmap.md) owns the module list and which phase builds each
module; the [diagnostic engine audit](diagnostic-engine-audit.md) and its
[execution plan](diagnostic-engine-execution.md) decompose the same work a second way, and that second numbering is **not**
extra phases — the mapping is at the bottom of this page so nothing is counted twice.

## What is already done

- **Milestone phases 0 to 12** of the build spec, including the demo (roadmap phase 1), the console, enrollment,
  signed upgrades, the alerting engine, the troubleshooting workflow, baselines, trends and triage.
- **Both Windows builds** of the same agent code (`windows-x64`, `windows-x86`), with the cross-architecture refusal
  proven live.
- **A live platform** (VPS, SQL Server 2022) serving both archives, and **a real cabinet test**: the agent installed
  read-only on a real Windows machine, self-updated to 0.2.5, and answered 19 of the 34 read operations before it was
  removed and its cabinet revoked. No write has ever run on real hardware.
- **The troubleshooting tool** (roadmap module 10's first half): one-click diagnosis with ranked findings, severity,
  certainty, evidence, a suggested fix, a runbook and a fix button where a safe operation exists.

## Phase 2 — blue screens, storage, drivers, incidents (part built)

Built already: the change watcher (`change` events), boots and reboot loops, stop codes, the crash and restart views, and
the fleet incident view that compares crashed with uncrashed cabinets.

Left in this phase:

- **Agent operations:** `crash.list` (bug checks, dump inventory, minidump metadata parsed on the cabinet: stop code,
  parameters, faulting module and version), `boot.history` (boots, shutdowns, uptime before each), `storage.health`
  (SMART, the NVMe health log, volume state).
- **Agent monitors:** new dumps, short uptimes, repeated boots.
- **Server:** crash signatures (stop code plus faulting module) grouped across the fleet; storage risk classes
  (Healthy, Attention, High risk, Critical, Unknown) from configurable rules; power-loss classification (bug check,
  power loss, forced off, unknown).
- **Console:** one crash investigation page per cabinet with a timeline of updates, driver changes, storage errors and
  crashes; the fleet incident page comparing affected and unaffected cabinets by model, build, driver and update.
- **Drivers and services half of the diagnostic engine** (engine phase 2): Plug and Play change events, device history,
  functional verification of a device, driver and service work.
- **Also in this phase:** fleet incident correlation, one timeline per cabinet with a daily health snapshot, incident
  response mode, and evidence preservation (hashed bundles with their source, resumable uploads).
- **The foundation of the diagnostic engine is the first slice of this phase** — see the mapping below. Until it exists,
  the modules above have nowhere to record a symptom, a hypothesis and a verified repair.

## Phase 3 — network, services, boot, updates, fleet operations (part built)

Built already: adapters, IP, DNS, gateway, ping, the DNS and TCP tests, firewall profiles and rules, client firewall
policy and bulk apply, and the drift alert.

Left in this phase:

- **Network diagnostics:** routes, ARP, connections, adapter statistics, network profile, proxy, per-server DNS,
  traceroute, and **the SQL connectivity ladder** (DNS, TCP, TLS, login-free TDS pre-login) that proves a server answers;
  the automatic diagnosis that turns those into findings.
- **Services, processes and devices:** dependencies, process signer and parent, application-crash correlation (WER),
  scheduled-task health, startup apps, `process.end` and `app.restart` behind a per-client allowlist; the NVMe health
  log, volume health, CPU/memory/page file, WHEA detail, USB power settings, BIOS, Secure Boot and TPM, and the files
  installed by each driver.
- **Boot and recovery:** read-only boot configuration, WinRE status, pending reboot, boot-critical services.
- **Windows Update:** install security and quality updates, pending reboot, fleet compliance, "who has KB X".
- **Cabinet-specific:** profiles for the three scanner types, vendor middleware services, required ports and endpoints.
- **Fleet operations and time:** the fleet operations page (select by client, site or hand-picked cabinets; preview;
  jobs with per-cabinet results), per-site time zones and clock sync, execution control (fixed target list, concurrency,
  staggering, cancellation), primary-cabinet protection, site topology ("all cabinets at a site went quiet together"),
  pre-maintenance preflight for each disruptive operation.
- **Safe remediation beyond what exists:** restart, updates, time zone and allowlisted registry values, each typed,
  role-checked and verified.
- **The network and application half of the engine** (engine phase 3) and **the sustained connection check**: path-health
  interpretation is written and tested but nothing feeds it samples — no table, no ingest, no sampler, no page.

## Phase 4 — the support call and controlled remediation

- **Symptom playbooks** (module 10's second half): read-only checks first, findings with how sure they are, the fix
  offered, verification, case notes.
- **Reports and case notes** (module 16): a diagnosis report and Issue/Findings/Actions/Pending/Next steps, copied into
  Salesforce, with no patient data.
- **Support call mode** (module 43): choose a symptom, run its playbook, apply the fix, get the notes.
- **Before and after snapshots** (module 29) generalised to every fix, with a comparison.
- **Change tracking** (module 36): one timeline of updates, drivers, software, services and network changes.
- **Site readiness** (module 38) and **preventive maintenance** (module 44): a per-site checklist with no "unknown counts
  as ready", and the daily and weekly exception reports.
- **The controlled-remediation half of the engine** (engine phase 4): the remediation registry, per-incident approvals,
  what a repair is allowed to touch, and functional verification.

## Phase 5 — configuration, software and the agent's own health

- **Configuration drift** (module 8) and **configuration backup** (module 28): versioned baselines per client and model,
  snapshots of approved settings, comparison, restoring chosen items.
- **Registry** (module 22) and **environment variables** (module 23): allowlisted keys read and compared; allowlisted
  values written with a backup and verification.
- **File deployment** (module 24), **software lifecycle** (module 25), **dependency mapping** (module 30).
- **Agent and server** (module 14): agent health in the console; **agent self-recovery** (module 26): agent health and
  crash history, and a recovery task that can only restart the agent.
- **Peripheral reliability** (module 34): scanner reconnect history and comparison across cabinets.
- **Alerting** (module 15): maintenance windows, repeated-restart and USB disconnect alerts.
- **The extended half of the engine** (engine phase 5): storage, performance baselines, integrity scans (DISM and SFC)
  and security.

## Phase 6 — advanced diagnostics and fleet intelligence

- **Advanced diagnostics** (module 17): Defender, BitLocker, certificates, time, power plans, DNS cache and profile
  changes; ETW only on demand.
- **Performance analysis** (module 32): counters for CPU, memory, paging, disk latency and network, with bottleneck
  findings that carry their measurements.
- **Windows installation health** (module 33): read-only servicing state, and DISM and SFC as Tier 2 operations.
- **Packet capture** (module 31): Admin-started, 60 seconds at most, filtered, size-capped, deleted at retention.
- **Out-of-band** (module 27): detect AMT or vPro only.
- **The intelligence half of the engine** (engine phase 6): failure rates per driver, update and hardware model;
  recurrence per component; cross-signal correlation; health scoring; the unified timeline; an optional plain-language
  explanation.
- **UI, accessibility, tests and the feature matrix** (modules 18, 19, 20, 46, 47) are added inside every phase above,
  not after them.

## Not phases: what has to happen outside the code

These are gates, not phases, and they block a real clinic, not the build:

1. **Release-signing certificates (KMS)** — releases are still signed with the development key, so the installer needs
   `-AllowUnsigned`.
2. **TPM-held agent keys.**
3. **An independent penetration test.**
4. **A writable test on real cabinet hardware** — the read path is proven on a real machine; no write has ever run on
   real hardware.
5. **A real 32-bit cabinet** (control-half session 9) — the x86 build and its refusal are proven, but the install on a
   32-bit machine waits for a machine on the cabinets' own network.
6. **The cabinets' network** — most of phase 3 only matters against real cabinets, so reachability has to be settled to
   prove it.

## Fixes from the hardware test (2026-10-30)

Agent 0.3.1 on a real 64-bit Windows 11 machine: 34 of 34 reads and the reversible writes worked. These came out of it, in the
order they are being fixed.

- [x] **Client pause did not stop a write (high).** The write check itself was right. The CLI paused by client id with no check
  and no feedback, and a removed client with the same name ("Home") could be paused instead of the live one. Now
  `writes pause --client` refuses a removed client and says which client and how many cabinets it covers, and
  `--cabinet <id>` pauses the cabinet's own client. Tested in `server/test/write-safety.test.ts`.
- [x] **Resume-writes did not resume (medium).** The hourly count still held the writes that tripped the limit, so the next write
  paused the person again. Resuming now restarts the count (migration 0018). Same test file.
- [x] **A config file with lost permissions kills the agent silently (medium).** Reading the config failed with "access denied",
  which was not caught, so the network service exited before logging anything. Now it logs "Refusing to start" with the reason
  and the remedy (run the installer again) and exits cleanly (#119). Owner's decision: the broker does not restore the file's
  permissions; lost permissions can mean tampering, so they are reported, not quietly repaired.
- [x] **A fleet job or bulk firewall change over the hourly limit was refused but did not pause the person**, though the refusal
  said it did. Every write path now pauses the same way. A job or bulk change still counts as one write, so working across many
  cabinets does not reach the limit sooner. Tested in `server/test/write-safety.test.ts`.
- [x] **The approved-applications list cannot be set outside the console (medium).** The refusal said only that the service was
  not on the list. It now says why: no list at any level (the tester's case), a damaged list, an empty list, or a list that
  leaves this out, and that an Admin sets it under Admin > Approved programs. Owner's decision: no CLI command; the console,
  with its confirmation, audit and signing, stays the only way to set the list. The page now also sets one cabinet's own list
  (owner's decision, 2026-10-31): a replacement takes over the old cabinet's list, which wins over every level above, and a
  damaged one had no way out in the console.
- [x] **Two minor items to check.** `power.status` reports USB selective suspend as plugged-in/battery values: intended, since Windows
  keeps one of each and `power.set` turns both on or off; the contract now says so. `package verify` on files that are not
  installers: "checked" does not reproduce on current main, which prints `refused`. But a non-MSI file was refused as
  `signature_invalid` (a signature failure); it is now `verification_failed`, the code a non-driver file already got.
- [ ] **Two test-and-page follow-ups from the #130 review.** `server/test/installer-scripts.test.ts` finds pwsh only at three fixed
  paths, so a pwsh installed elsewhere (for example under the home folder) skips two tests. The Approved programs page's client
  list load (the page's first load) shows nothing when it fails. (The signing test's wrapped-text assertion was fixed in #130.)
- [ ] **Two follow-ups from the #130 review.** `troubleshooting.test.ts` failed 8 times in one full run at `--test-concurrency=2`
  (sign-in in `ConsoleHarness.account`) and passed alone and in the next run: a contention flake to root-cause. The same
  shape hit `demo.test.ts` twice at 7679e3c (a drift alert that did not resolve in time; a count of 0 for 1), 15/15 alone. The
  approved-list-signing refusal test's title does not name the one-key rule it now covers.
- [ ] **Two more reds of that shape on CI at `ba42057` (2026-11-01), one per run, neither in a file the PR touched.**
  - `fleet-jobs.test.ts` "preview says what each cabinet gets…" (job 124747966648): the cabinet the test made offline came back
    online, because the demo simulator's heartbeat sweep refreshed it between the test's update and the preview. Fixed in PR
    #132: the test moves that cabinet into the simulator's `offline` scenario (which it never heartbeats), waits for a sweep in
    progress, then makes it offline, and asserts each cabinet's skip reason by its ID.
  - `console-setup-e2e.test.ts` (job 124747977897): the step-up dialog after approving the agent stayed open for 30 s; the log
    cannot say whether the approval was refused or still running. Not root-caused. PR #132 makes the wait report which it was
    (the console's refusal text, or "still Confirming…"), so the next occurrence names its cause.
- [ ] **Two more at `e429b81` (one run, job 124754172624), also outside the PR's files.**
  - `console-screens-e2e.test.ts` "every page fits its screen…": asserted `#root` visible with `isVisible()` (which does not wait)
    straight after `goto`, before the console had drawn. Fixed in PR #132: it waits for the sign-in form first.
  - `troubleshooting.test.ts` "a drive that is failing and a clock that is wrong…" (62 s, past the 60 s diagnosis limit): the ICU
    diagnosis had no time-skew finding. Not root-caused; the assertion now prints the diagnosis' state and findings.
  - `troubleshooting.test.ts` again at `b811d72` (job 124775471652), the #130 shape, as one burst: "Diagnose this cabinet" got
    a 500 (`server_error`) from POST /diagnose at 07:05:05.028, then the file's eight remaining tests each failed signing in
    within the next second (to 07:05:05.878). Two different routes failing inside one second points at a connection-level
    failure (the database connection, not anything about /diagnose); there was no later test to show recovery, and the paired
    run of the same commit was 843/843. The app runs without a logger, so the error itself was not in the log; the file now
    records every unexpected server error (an `onError` hook that skips the 4xx answers) and prints them, and the harness's
    sign-in assertion shows the responses it got.
- [ ] **The server suite takes about 19 minutes on CI.** Complete runs took 18.6 and 20.1 minutes (jobs 124747977897 and
  124747966648, `ba42057`); two earlier runs were cancelled by the old 15-minute limit with 293 (`c2268977`) and 296
  (`947c1a09`) of 824 passed and none failed. The step's limit is now 40 minutes (PR #132). Worth finding the slow files (the browser tests and
  the real-agent ones are the likely ones) before it creeps up again.
- [x] **The result outbox read pending results back out of order after a restart.** It ordered them by file write time, then by
  name: two results written inside one file-time tick came back in name order (the owner saw
  `Results_survive_a_restart_until_delivered_then_are_kept_to_answer_repeats` fail one run in five), and a result the server
  offered again kept its delivery time and so came back first. Each pending file now gets a write time later than the last one
  (`ResultOutbox.StampPending`), on add and on requeue. Fixed in PR #132, with a frozen-clock test and a requeue test that fail
  without it.
- [ ] **On Windows a closed TCP port can read as "no answer" in a test series.** What the runs show: the series' own limit of
  2 seconds per connection (`NetworkTester.TcpSeriesAsync`) expired before the refusal came back, so the error was "No answer on
  TCP port ... within 2 seconds". On the same runner image (windows-2025-vs2026, 20261021.618) the strict test failed at
  `f38627de` (job 124714381133, the test took 8 s) and passed at `be976942` (job 124722989775), so the refusal sometimes comes
  back in time and sometimes not; how long Windows takes has not been measured. Changed, not proven (decision D1 in
  [decision-log.md](decision-log.md)): each connection now gets the single test's 5 seconds, a refusal ends the series, and two
  tries in a row with no answer end it, as does an 80-second budget; `statistics.sent` is the connections actually tried. The test is strict again on every
  platform and asserts one try for a refused port. **Not yet proven on Windows:** GitHub Actions is on hold, so the strict test
  has run only on Linux, where a refusal comes back at once. 5 seconds is more room, not a measured bound: if the delay can
  run past it, the strict test fails on Windows again.
- [ ] **A network diagnosis against a sync cabinet that answers nothing runs past its one-minute limit.** Worked out from the
  limits, not measured: a 10-request ping series with no replies takes 20.9 s and four silent port series 41.2 s (44.8 s
  before D1), before the gateway and DNS tests; reads still running at the minute show as "no answer within a minute".
  Options for the review: a time budget across the diagnosis's tests, or fewer tries once the ping series got no reply.
- [ ] **Still to run on hardware:** static `network.setIp`, lease release, restart and shutdown, update and driver uninstall,
  package install, `firewall.restore`, service and process control (needs an approved list), and a real 32-bit install.

## The engine's six phases, mapped so nothing is counted twice

| Engine phase (audit, section 5) | Where it lands |
|---|---|
| 1. Foundation (module contract, incident record, capability registry, findings as modules) | First slice of **phase 2** |
| 2. Drivers and services | **Phase 2** (with its phase-3 device work) |
| 3. Network and application | **Phase 3** |
| 4. Controlled remediation | **Phase 4** |
| 5. Extended | **Phase 5** |
| 6. Intelligence | **Phase 6** |

An earlier answer of mine counted "2 roadmap phases plus a 6-phase engine" — that double-counted the same work. The count
is **5 phases**, and the table above is the reason.

# What is left, and what each part contains

## Where it stands (2026-11-09, after #225)

The work follows the owner's brief of 2026-11-07: findings F1 to F23, one finding or requirement per PR, in the order of the table
[at the bottom of this page](#the-build-specs-findings-f1-to-f23-added-2026-11-07). That table is the count.

**Done** (merged, each with a decision-log entry and a test that fails without it):
- F3, F4.
- F6.R1 to R5.
- F8.R1 to R5.
- F17: all five requirements, D50 to D54.
- F18.R1 and R2.
- F19.R7.
- F21.R1. F21.R2: table ownership written down and enforced as a ratchet (D56); the paydown so far: `fleet_patterns` (#223, D65), `config_changes` (#224, D66) and `enrollment_baselines` (#225, D67) through their owners, and the ownership reader now sees writes with a row limit (#224).
- A network diagnosis settles its baseline alert before it says it is done, found in review of #219 (#222, D64).
- F21.R3: the cabinets' ingest and the console run apart when asked to (SERVER_ROLES, #218, D60).
- F21.R4, first view: the kinds of blue screen read through their alerts, 3,861 ms to 11 ms at 10,000 cabinets (#219, D61).
- F21.R4, second view: the readings search reads each answer's names, not its stored JSON, 9,256 ms to 943 ms at 10,000 cabinets (#221, D63).
- F21.R5, first half: the line a client's own database would follow, written down and tested (#220, D62).
- F6: a site installer as a fleet install script a remote management tool runs as SYSTEM (D57).
- The cabinet at a glance (D58) and a read-only acceptance check on the cabinet (D59), both asked for by the owner.
- F20: which Windows the fleet runs, by edition, build family and architecture (#211, D55).
- F7: the role level, the Differences view by role, watched services from the role baseline.
- F14.R3: a service set to restart the computer is alerted.
- F12.R3: the server half of the trace's sync address.
- F23 is closed. F22 is parked by the owner.

**In review:** F21.R2, fourth paydown: the certificate check's write to `notifications` goes through `notify()`, its owner (D68). 118 cross-module writes are left on the debt list.

**Can still be built in this environment** (server and console only). The PR counts are worked out from the code, not measured:

| Work | Finding | PRs |
|---|---|---|
| Move the 118 listed cross-module writes behind their owners (fleet_patterns D65, config_changes D66 and enrollment_baselines D67 done, notifications in review D68; 14 of them are the retention sweeps in maintenance.ts), one table or a few at a time. Boundary input checked against its contract, and side effects through an idempotent writer. | F21.R2 | about 13 to 20 |
| Console views read aggregates, never raw sample scans, with the SQL measured at 10,000 cabinets. The kinds of blue screen (D61) and the readings search (D63) are done; drives at risk already reads its aggregate; the other fleet-wide views are left to measure. | F21.R4 | about 1 more |
| A documented path to per-client databases, with the connection resolved per client. The path is done (D62); the connection resolved per client is left. | F21.R5 | about 1 more |
| Process and task expectations, for whatever the agent already reports | F7 | about 1 or 2 |

That is about 16 to 24 PRs. Most of them are the F21.R2 paydown, which can stop at any point without leaving anything broken.

**Blocked, and on what.** None of this can be finished here, whatever the effort:

- **The agent cannot be built in this environment** (NuGet's NU3018 behind the HTTPS-only proxy). This blocks:
  - F2's agent side;
  - F9;
  - F10 to F12's samplers;
  - F13 and F14.R1 to R2;
  - F15 and F16;
  - F18.R3, the watchdog;
  - F19.R1 to R6, the driver store, rollout and rollback;
  - F6's unattended installer switch;
  - F20's update source;
  - the crash fields decided in D30.

  It is unblocked by building the agent where NuGet is reachable: the owner's Windows machine, or CI once GitHub Actions run again.
- **Outside the code:**
  - F1.R1, the release-signing certificate (gate 1);
  - F5, a real cabinet's driver signer;
  - F20's smoke test per build family, which needs real cabinets of each family;
  - gates 2 to 6 below.
- **The owner:** row 12, Windows Update, has to be cut into a finding before it can be built.
- **CI:** GitHub Actions are on hold for billing. Every PR states the local full run that stands in for it.

So the server-side work left is the scale-out readiness of F21, plus a little of F7. After that, every remaining item waits on an agent
build, real cabinets, a purchase or an owner decision. This page lists them so none is quietly dropped.

## Roadmap phases (reviewed against the code on 2026-11-03)

This review was made at `771267d`, after PRs #135 to #140, before the brief's findings, which the table at the bottom tracks. Every line
was checked against the contracts, agent, server and console, and says **built**, **partly built** or **not built**, with where to
look. In those terms 5 roadmap phases were left: 2, 3, 4, 5 and 6. Separately, **6 gates outside the code** block a real clinic whatever
the phases say (the last section before the fixes list).

The [roadmap](../spec/13-roadmap.md) owns the module list and which phase builds each module. The archived
[diagnostic engine audit](archive/diagnostic-engine-audit.md) and its [execution plan](archive/diagnostic-engine-execution.md) split the
same work a second way. That second numbering is **not** extra phases: the mapping is at the bottom of this page, so nothing is counted
twice.

### What was already done at that review

- **Milestone phases 0 to 12** of the build spec, including the demo (roadmap phase 1), the console, enrollment,
  signed upgrades, the alerting engine, the troubleshooting workflow, baselines, trends and triage.
- **The catalog: 56 operations, 38 reads and 18 writes** (`contracts/schemas/operations/catalog.json`). Agent version 0.3.1.
- **Both Windows builds** of the same agent code (`windows-x64`, `windows-x86`), with the cross-architecture refusal
  proven live.
- **A live platform** (VPS, SQL Server 2022) serving both archives.
- **Real hardware.** First test: an earlier agent installed read-only, self-updated to 0.2.5, answered 19 of the then 34
  reads. Second test (2026-10-30): **agent 0.3.1 on a real 64-bit Windows 11 machine, 34 of 34 reads and the reversible
  writes worked**; its fixes are listed below. The writes not yet run on hardware are listed there too.
- **The troubleshooting tool** (roadmap module 10's first half): one-click diagnosis with ranked findings, severity,
  certainty, evidence, a suggested fix, a runbook, known fixes and a fix button where a safe operation exists.
- **Since the last version of this page:** replacing a cabinet with re-apply (8d), site policies at approval (8c), client
  scanner switch (8b), sync cabinets per cabinet (8a), the diagnostic engine foundation parts 1 to 5a, the audit-chain race
  fix (#135, migration 0019), the diagnosis time budget (#137), the e2e browser start (#138), the SQL connectivity operation
  (#139) and the product-test fixes (#140).

## Phase 2 — blue screens, storage, drivers, incidents (mostly built)

**Built:**
- Boots and reboot loops from heartbeats and events, stop codes, crash events (`server/src/services/crashes.ts`).
- The crash view per cabinet with a timeline of what changed before it (updates, drivers, services, software, storage
  errors), and the fleet **Incidents** page comparing crashed with uncrashed cabinets (`console/src/pages/Crashes.tsx`,
  `fleetCrashIncident`).
- Event watching on the agent for bug checks, Kernel-Power, WHEA, disk, NTFS and storage-controller resets
  (`agent/.../Monitoring/EventLogWatch.cs`).
- Drive health: daily SMART in the heartbeat, history, levels ok / watch / act / urgent, disk-full forecast, alerts, the
  fleet "drives at risk" view (`server/src/services/drives.ts`, `trends.ts`).
- One history per cabinet (`cabinet-timeline.ts`) and health with the last known healthy state (`cabinet-health.ts`).
- Evidence packages: hashed per section and whole, audited (`evidence.ts`).
- **Engine foundation parts 1 to 5a:** module contract, incident record (migration 0017), capability registry, today's
  cabinet checks and the network diagnosis as modules, incidents shown on the cabinet's History tab.
- Storage risk classes (D18): Healthy, Attention, High risk, Critical and Unknown, with thresholds an Admin sets in
  Settings and defaults from common drive-maker and field-study values. (Correlation with crashes and NVMe counters stay with
  `storage.health` below.)

**Partly built:**
- Power-loss classification (D19): each unexpected restart is a blue screen, a held power button, or power lost / Windows frozen,
  from the event's own fields or a blue screen logged within 10 minutes. The agent sends Kernel-Power 41's fields with the event
  (proven on Linux; the Windows read itself waits for CI or a real cabinet).
- Evidence preservation: hashed bundles built; resumable uploads not.

**Not built:**
- (Agent monitors for new dumps and short uptimes are built (D20): `crash_dump` and `short_uptime` events, a dump joining its blue-screen alert, short runs feeding the reboot-loop count.)
- (`storage.health` is built: the NVMe health log and each fixed volume's repair state (its HealthStatus) and dirty bit. Feeding its counters
  into the drive risk class and trends is not built yet.) (`crash.list` is built: each small dump's stop code and
  parameters from its header, and the full dump's presence; the faulting module is not read, since a small dump's header does not
  hold it.) (`boot.history` is built: each start, how the run before it ended and how long it lasted, on the cabinet's
  crash page.)
- (**Crash signatures are built (D26)** by stop code and the exception or subtype Windows records, across the fleet with a report per kind.)
  The faulting module waits on a real sample dump (09-open-decisions).
- (**Fleet alarm level is built (D25):** major fleet problems ring at once, minor ones only once they spread; each fleet report has the
  runbook for its issue, or how to name an unknown error.)
- (**Incident response mode is built (D24):** the fleet alert's report counts who has recovered and who is still affected, shows how it went
  hour by hour, and stages recovery site by site through Fleet operations.)
- (**Engine foundation part 5b is built (D21):** a blue-screen or reboot-loop alert opens one crash incident per cabinet (module
  `crash-incidents`), each alert linked once with its count, closed when all its crash alerts are resolved; shown on the cabinet's crash page.)
- **The drivers and services half of the engine** (engine phase 2).

## Phase 3 — network, services, boot, updates, fleet operations (mostly built)

**Built:**
- Network: adapters with error and discard counters, routes, ARP neighbours, network profile, proxy, Wi-Fi, IP, DNS per
  server, gateway, ping series with loss and jitter, TCP tests, traceroute (`network.trace`), listening ports and connections
  (`network.listeners`), firewall profiles and rules, client and site firewall policy with bulk apply and drift alert, site
  network baselines, and the automatic network diagnosis with findings and one-click fixes.
- Services and processes: list, control, watched services with auto-restart and an alert after 3 failures, `process.end` and
  restart aimed only at the per-client approved-applications list (`app-control.ts`, `controlled-targets.ts`), startup
  programs and scheduled tasks with last result, CPU, memory, commit and page activity, volumes.
- Hardware and security: BIOS, Secure Boot, TPM, last boot, USB power settings (`power.status`, `power.set`).
- Updates: installed updates, uninstall, pending reboot, and "who has KB X" through the fleet reading search.
- Fleet operations and time: the fleet operations page, jobs with a fixed target list, batches, per-cabinet results,
  verification and cancellation, sync cabinets last (`fleet-jobs.ts`); time zones per site, client and fleet; clock sync;
  wrong-zone and clock-skew alerts (`time.ts`); a whole site going quiet together raises a site alert (`site-outage.ts`).
- Safe remediation: restart, time zone, DHCP renew and release, DNS flush and set, static IP, firewall, health check
  (DISM `/CheckHealth`).

**Partly built:**
- WHEA: events are watched and shown; their detail is not parsed.
- Volume health: free space and NTFS errors; no volume state read.
- Required ports: sync ports per client and site; no per-vendor endpoint list.

**Not built:**
- (Built since: the SQL connectivity ladder, as the operation `database.connectivity` (D13) and as its own module in the network
  diagnosis on sync port 1433 (D15).)
- Process signer and parent; service dependencies; the files installed by each driver. (**Application-crash correlation is built (D29):**
  Application Error 1000 and Application Hang 1002 are known by their program, so each program is its own alert and fleet pattern. The
  faulting module and exception code need the agent to send them: decided 2026-11-07 (D30), and the agent side waits for the first signed release after F1.)
- Boot and recovery: boot configuration, WinRE status, boot-critical services.
- Installing updates, and update compliance across the fleet.
- Profiles for the three scanner types and their vendor middleware services.
- Pre-maintenance preflight for each disruptive operation.
- Allowlisted registry values as a typed write.
- **The sustained connection check:** the path-health analysis and correlation are written and tested
  (`pathhealth-*.ts`), but there is no table, no ingest, no sampler on the agent and no page.
- **The network and application half of the engine** (engine phase 3).

## Phase 4 — the support call and controlled remediation (partly built)

**Built:**
- Runbooks for issue types and diagnosis findings, with optional read-only checks and one-click fixes, Tier 2 proposes and an
  Admin approves (`runbooks.ts`); known fixes saved with their environment (`known-fixes.ts`).
- Case notes, append-only, with Admin redaction (`case-notes.ts`); resolving an alert records cause and fix.
- Change tracking: the cabinet's history and the "what changed" timeline before a crash.
- A person's own activity (changes made, checks run, alerts resolved, fixes saved) written as case notes to paste into a
  ticket (`activity-report.ts`).

**Not built:**
- Symptom playbooks and support call mode (choose a symptom, run its playbook, apply the fix, get the notes).
- The case report in Issue / Findings / Actions / Pending / Next steps form (the activity report above is the part built).
- Before and after snapshots for every fix (the writes that report a change return the before and after of what they
  changed, and only a firewall write keeps it as history and takes a snapshot first).
- Site readiness checklist; preventive-maintenance daily and weekly exception reports.
- **The controlled-remediation half of the engine** (engine phase 4): the incident record has the approval states, but no
  repair goes through it.

## Phase 5 — configuration, software and the agent's own health (partly built)

**Built:**
- Configuration drift and backup: snapshots, versioned baselines per scope (global, model, client, site, cabinet), drift, health, last
  known healthy, and re-applying settings on a replacement cabinet (`baselines.ts`, `baseline-drift.ts`,
  `replacement-reapply.ts`).
- Software inventory and approved package install from the signed software library (the only way files reach a cabinet).
- Peripheral reliability: the scanner's disconnects and what changed before them (`scanner-history.ts`), USB rules for
  absent, reconnecting and dependent devices (`usb-rules.ts`).
- Alerting: repeated service restarts, USB disconnects, suppressions.
- Agent self-check after an upgrade, with a security alert when it fails.

**Not built:**
- Restoring chosen configuration items on any cabinet (only replacement re-apply exists).
- Registry and environment-variable reads and writes.
- Software lifecycle and dependency mapping.
- Agent health and crash history in the console; agent self-recovery.
- Maintenance windows.
- **The extended half of the engine** (engine phase 5): performance baselines, integrity scans beyond `/CheckHealth`.

## Phase 6 — advanced diagnostics and fleet intelligence (mostly not built)

**Built:**
- Defender, BitLocker, certificates, activation, power plans, DNS cache, time (`system.security`, `power.status`,
  `dns.cache`, `time.status`).
- Performance samples in the heartbeat with trends; CPU, memory and disk counters on request (`system.performance`).
- Error trends per issue type and per error, marked new or rising (`error-trends.ts`); the triage queue.

**Not built:**
- Bottleneck findings from the performance counters; network counters.
- DISM and SFC repair as Tier 2 operations (only `/CheckHealth` exists).
- Packet capture; AMT or vPro detection; ETW on demand.
- **The intelligence half of the engine** (engine phase 6): failure rates per driver, update and model; recurrence;
  cross-signal correlation; health scoring; an optional plain-language explanation.
- UI, accessibility, tests and the feature matrix (modules 18, 19, 20, 46, 47) are added inside every phase, not after.

## Not phases: what has to happen outside the code

These are gates, not phases, and they block a real clinic, not the build. All six were re-checked on 2026-11-02 and still
stand:

1. **Release-signing certificates (KMS)** — releases are still signed with the development key, so the installer needs
   `-AllowUnsigned` (`docs/platform/archive/readiness.md`).
2. **TPM-held agent keys** — the agent's key is in the software key store (`MicrosoftSoftwareKeyStorageProvider`,
   `agent/src/Cabinet.Agent.Windows/ServerConnection.cs`).
3. **An independent penetration test.**
4. **The remaining writes on real hardware** — reads and the reversible writes ran on 2026-10-30; static IP, lease release,
   restart and shutdown, update and driver uninstall, package install, `firewall.restore`, and service and process control
   have not (see the fixes list).
5. **A real 32-bit cabinet** — the x86 build and its refusal are proven, but the install on a 32-bit machine waits for a
   machine on the cabinets' own network.
6. **The cabinets' network** — most of phase 3 only matters against real cabinets, so reachability has to be settled to
   prove it.

## Fixes from the product test (2026-11-02)

Agent 0.3.1 on a real Windows machine against main at `bfe475a`: 35 of 35 reads returned, the out-of-band firewall alert and the
platform-authored write attribution worked. Its findings:

- [x] **`reliability.list` failed outright on a long Windows message (high).** Text was cut at 300 for a 256 contract field; the
  DNS cache data and certificate subject had the same mismatch. Fixed in #140 (one 256 cap, contract-checked tests).
- [x] **The firewall state on the platform lagged up to 5 minutes after a change (medium).** Fixed in #140: a changed firewall asks
  for an early heartbeat, at most once every 15 s.
- [x] **One-off security alerts never closed (medium).** Owner's decision: they close after 14 days with no recurrence (D14). #140.
- [ ] **No backup ran on the test host (low, environment).** `deploy/setup.sh` installs the nightly cron job; that host was set up
  without it. Host task: install `/etc/cron.d/cabinet-backup` and run one backup. Not a code change.
- [x] **The agent's "log is being flooded" notice was unrecognized (low).** Fixed in #140: migration 0020 maps `agent_status` to
  the built-in "Agent problem" issue type.

## How many PRs were left at the 2026-11-03 review (superseded)

**Superseded by the count at the top of this page.** The brief of 2026-11-07 re-cut this work into findings. Most of the phase lines
below became findings, and most of those are agent-side and blocked here. The estimate is kept as it was made.

At that review: **about 55 to 60 PRs** at the size PRs have been so far (one feature or fix each, with its tests). This is **worked out** from the
"not built" and "partly built" lines above, one PR per line and two to four for each engine half; it is not a measurement, and it
changes whenever a line is split, merged or dropped. The six gates outside the code are not PRs.

| Where | PRs (estimate) | What they are |
|---|---|---|
| Phase 2 | ~6 | the faulting module of a crash, crash signatures, power-loss classification, resumable evidence, the drivers and services engine half |
| Phase 3 | ~18 | Process signer and parent, service dependencies, driver files, boot and recovery, update install and compliance, scanner profiles, preflight, registry writes, the sustained connection check, WHEA detail, volume state, the network and application engine half |
| Phase 4 | ~10 | Symptom playbooks and support call mode, the case report, before and after snapshots, site readiness, preventive-maintenance reports, the controlled-remediation engine half |
| Phase 5 | ~10 | Restoring chosen settings, registry and environment variables, software lifecycle, dependency mapping, agent health in the console, self-recovery, maintenance windows, the extended engine half |
| Phase 6 | ~10 | Bottleneck findings and network counters, DISM and SFC repair, packet capture, AMT detection, ETW, the intelligence engine half |
| Open fixes | ~3 | Turning demo mode on takes 17–25 s (measured; every test that turns it on now allows 90 s, D17 and D27; seeding sites side by side was tried and is slower, D27), the installer hash check on CI (D2), and an intermittent timeout in `console-approved-apps-e2e`. The cabinet's own list did not appear within 30 s after a retried site load. It has happened in a few full runs, never alone, and not in 8 runs at four at a time; the page was left in "Loading…". The cause is not yet known. The test now also prints how the last approved-programs requests ended (sent, answered with a status, or failed in the browser), which tells the server, the network and the page apart. |

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
- [x] **Two test-and-page follow-ups from the #130 review.** `server/test/installer-scripts.test.ts` found pwsh only at three fixed
  paths, so a pwsh installed elsewhere (for example under the home folder) skipped two tests; it now looks at `PWSH`, then the
  full-path folders on `PATH`, then those three (`server/test/find-pwsh.ts`, always a full path). The Approved programs page's
  client list load (the page's first load) showed nothing when it failed; it now says so with "Try again". (The signing test's wrapped-text assertion was fixed in #130.)
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
    cannot say whether the approval was refused or still running. Not root-caused. Passed 3 of 3 locally on 2026-11-02 (with
    the D10 fix), so not reproduced; a 500 from the audit race above would also leave the dialog open, but that is not shown. PR #132 makes the wait report which it was
    (the console's refusal text, or "still Confirming…"), so the next occurrence names its cause.
    Since then (2026-11-02 and 11-03) the same test failed twice in local full runs, both at "Turn demo mode on" and both
    "still Confirming…": that request takes 20–25 s alone (measured), so the step now has 90 s (D17). The approval-step failure
    above is a different step and stays unreproduced.
- [ ] **Two more at `e429b81` (one run, job 124754172624), also outside the PR's files.**
  - `console-screens-e2e.test.ts` "every page fits its screen…": asserted `#root` visible with `isVisible()` (which does not wait)
    straight after `goto`, before the console had drawn. Fixed in PR #132: it waits for the sign-in form first.
  - `troubleshooting.test.ts` "a drive that is failing and a clock that is wrong…" (62 s, past the 60 s diagnosis limit): the ICU
    diagnosis had no time-skew finding. Not root-caused; the assertion now prints the diagnosis' state and findings.
  - **Root-caused 2026-11-02 (decision D10 in [decision-log.md](decision-log.md)): an audit-chain race, a product bug.**
    Audit appends made outside a transaction could take the same sequence number and leave the chain head behind the log,
    after which every audited action failed with a duplicate key until the head caught up. Fixed by migration 0019;
    `audit-concurrency.test.ts` failed 231 to 239 of 300 appends per run before it and passes after it. The #130 run (8
    sign-in failures in one file) and the `demo.test.ts` reds have the same shape but logged no error text, so they are
    likely the same cause, not proven.
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
- [x] **A network diagnosis against a sync cabinet that answers nothing runs past its one-minute limit.** Fixed (D11): the
  limit is two minutes, and the plan never asks for more than the agent's 10 network tests a minute. Worked out from the
  limits, not measured: a 10-request ping series with no replies takes 20.9 s and four silent port series 41.2 s (44.8 s
  before D1), before the gateway and DNS tests; reads still running at the minute showed as "no answer within a minute" before D11 changed it.
  The options weighed and why two minutes was chosen are in D11.
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

## The build spec's findings (F1 to F23), added 2026-11-07

The owner's brief of 7 November 2026 (read at `main` `84f4a7e`) adds findings F1 to F23 to the work left. Each is done one finding, or one
requirement, per PR, in this order. The order replaces the order above where they overlap. No item below is done until its "proves it"
holds and its numbers were run. The brief itself is not copied into the repo: `docs/spec` stays the source of truth, and each finding
changes it with the behaviour.

| # | Work | Findings | State |
|---|---|---|---|
| 0 | Production trust: publisher pinned, approved-list keys, a signing pipeline that cannot emit unsigned binaries, one observed upgrade | F1 | Open. R1, the pinned certificate, needs the release-signing purchase (gate 1). R3 and R4 are code. |
| 1 | Rollback integrity, CLI authority, audit completeness | F2, F3, F4 | F3 done (D31). F4: automatic transitions audited (#174); every other automatic close, the fleet job end, the command expiry off the poll, and the sweep test that no state change skips the audit (#176, D32). F2: the server side was already met; the agent side is blocked, as the agent cannot be built here |
| 2 | Role templates and expected sets, seeded from a healthy cabinet; scheduled-task results | F7, F9 | F7: a role baseline level (D33); the Differences view by role and by baseline level (R3); watched services from the role baseline (R4, D34). Open: process and task expectations, with expected processes and drivers. F9 is agent work, blocked here |
| 3 | Setup: site-scoped installer, batch approval, applied standards, bulk import | F6 | R1 site installer (D35); R2 batch approval (D36); R3 applied standards (D37); R4 bulk import of clients and sites (D39); R5 setting origins (D38). A site installer as a fleet install script a remote management tool runs as SYSTEM (D57). Open: running it on a real cabinet, with the agent build |
| 4 | The workload's progress signal, file staleness, declared ports | F10, F11, F12 | F12.R3: the trace's sync address is server-filled (audit-network item 7, server half). Open: the rest, most of it agent-side samplers |
| 5 | One definition of healthy: item-level comparison, honest empty states, ranked changes | F8 | R1 one definition of last known healthy (D41); R2 the mark in use is never pruned (D40); R3 what changed and came back is listed (D42); R4 one route, ranked by closeness to the problem (D44); R5 nothing to compare always says why (D45). Done |
| 6 | Service dependencies, start order, recovery actions | F14 | R3 a service set to restart the computer is shown and alerted (D43). Open: R1 dependencies and R3 in stored configuration, R2 the blocking dependency named (agent build) |
| 7 | The chain under the workload: database, its error log, the monitoring agent | F15 | Open |
| 8 | Process history: trends, leak and wedge, tree, holder | F13 | Open |
| 9 | Scheduled, change-gated sampling for the remaining reads, inside the capacity budget | F16 | Open |
| 10 | Fixes carried, verified, fleet-run; the watchdog | F18 | R1 a close found by the reading names the fix it verifies, with before and after (D47); R2 a fleet job names offline cabinets apart from failed ones (D46). Open: R3 the watchdog (agent) |
| 11 | Drivers: store against bound, matching, rollout, verification, version rollback; publishers per vendor | F19, F5 | F19.R7 firmware differing from its model's expectation is an alert (D48). Open: F19.R1-R6 (agent: driver store, rollout, rollback), F5 (a publisher entry needs a real cabinet's signer) |
| 12 | Windows Update check, install and defer | (to be cut as a finding first) | Open |
| 13 | Sharpening the two no-expectation detectors | F17 | Done: a rising unrecognised error opens a fleet pattern (D50); the trends say where they were cut (D51); a new kind of blue screen on two cabinets is its own fleet pattern (D52); a healthy cabinet at a site with no baseline offers to become it (D53); a change that leaves a cabinet unlike all its peers, where no baseline declares the setting, is an alert (D54) |
| 14 | Reach, scale and modularity: compatibility report, pagination, bounded search, single-writer jobs, ingest apart from the console API | F20, F21 | F21.R1 one writer per background job across instances (D49); F20: Windows in the fleet by edition, build family and architecture (D55); upload isolation, paged lists and the bounded search were already in the code (D55 names where); F21.R2 table ownership written down and enforced as a ratchet, 108 cross-module writes listed as debt, run-time table names declared (D56). Open: F20 the update source (needs an agent operation) and a real-cabinet smoke test per build family; F21.R2 paying the debt down, boundary validation and idempotent writers; F21.R4-R5. Done since: F21.R3 the ingest and the console run apart (D60) |
| 15 | Our own remote access | F22 | **Parked** by the owner, 2026-11-06 |
| -- | The installer carries an address a cabinet can dial | F23 | **Closed** 2026-11-07 (#171) |

**Ordering rule (from the brief):**
- Nothing that changes a cabinet ships before F1 and F2.
- Templates (F7) come before anything that needs a declared expectation.
- No new sampler ships before its rows per cabinet per day, retention and rollup are counted against the capacity budget.
- Nothing is split into a separate service before F21.R1 and F21.R2.

**Held back by the ordering rule:** the agent sending an application crash's faulting module and exception code (decided 2026-11-07, D30)
is an agent release, so it reaches cabinets only once F1 is closed.

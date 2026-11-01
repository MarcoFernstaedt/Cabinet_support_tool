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
  (sign-in in `ConsoleHarness.account`) and passed alone and in the next run: a contention flake to root-cause. The
  approved-list-signing refusal test's title does not name the one-key rule it now covers.
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

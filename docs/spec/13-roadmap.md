# Roadmap: the October 2026 module list

In October 2026 the product owner listed modules 1 to 47, plus the fleet time zone section of module 21. This file maps each one to what the platform already does, the phase that builds the rest, and how it fits the rules in [02-security-model.md](02-security-model.md) and [CLAUDE.md](../../CLAUDE.md).

Decisions taken with the owner are in [09-open-decisions.md](09-open-decisions.md), under "Demo and the module list".

This file is the plan, not the status: several modules it lists as to build have since been built (the trace, scheduled tasks, the route and ARP tables, volume health). [What the code has](../platform/remaining-phases.md#what-the-code-has-checked-on-2026-11-14) is checked against the source.

**Five phases are left — items 2 to 6 below.** The one place that count lives, with everything in each phase and the
reason it is five rather than six, is [../platform/remaining-phases.md](../platform/remaining-phases.md).

Order, as chosen by the owner:

1. The demo (done).
2. Blue screens and storage.
3. Network, updates, restarts and time.
4. Fleet operations and the support call workflow.
5. Drift, baselines and reliability.
6. Advanced diagnostics.

## How every module is built

These rules come from the platform's existing rules. They are not new restrictions.

- **Fixed operations only.** Released agent capabilities use the fixed, typed operation catalog with schemas for parameters and output. The [dev-only SSH transport](02-security-model.md#development-ssh-transport) is scoped to the development branch.
  - A "script" need becomes an operation. "Restart an approved application" becomes `app.restart`, with an allowlist kept per client.
  - Signed scripts stay out unless the owner decides otherwise. That would change the security model; see 09.
- **Files reach a cabinet only as signed packages from the software library** (milestone 5). Approved configuration files go the same way: a signed package, checked on the cabinet.
- **The cabinet application's database is never touched.** The owner also excluded every database diagnostic.
- **Programs are started by full path with an argument array.** `w32tm.exe`, `tzutil.exe`, `pktmon.exe`, `dism.exe` and `sfc.exe` run only inside the broker, with fixed arguments.
- **Unsupported is never shown as healthy.** Every reading has a state: measured, not supported on this hardware, or could not check.
- **A finding states how sure it is:** confirmed, probable, possible, insufficient evidence, or not supported. No root cause is claimed from correlation alone.

## Status by module

"Have" means it is built and tested. "Phase N" is the phase that builds the rest.

| # | Module | Have now | To build | Phase |
|---|---|---|---|---|
| 1 | Network diagnostics | Adapters, IP, DNS, gateway, ping, DNS and TCP tests; firewall profiles, rules, client policy, drift alert | Routes, ARP, connections, adapter statistics, profile, proxy, per-server DNS, traceroute; automatic diagnosis with findings (milestone 11 spec); TLS handshake check to the server | 3 |
| 2 | Services and processes | Services list with recovery settings, start, stop, restart; watched services with auto-restart; processes with CPU, memory, owner | Dependencies; process signer and parent; application crash correlation (WER); scheduled task health; startup apps; `process.end` and `app.restart` with a per-client allowlist | 3 |
| 3 | Hardware and drivers | Devices with problem codes; drivers with signer and version; SMART; scanner checklist | NVMe health log; volume health; CPU, memory and page file; WHEA detail; USB power settings; BIOS, Secure Boot and TPM; files installed by each driver | 2, 3 |
| 4 | Blue screen investigation | BugCheck, Kernel-Power 41 and 6008 become "System crash" and "Unexpected shutdown" alerts | Crash evidence collection; minidump metadata parsed on the cabinet; crash timeline; reboot-loop detection; fleet crash grouping; minidump upload and packet capture (see 09) | **2** |
| 5 | Storage failure monitoring | SMART health; disk event IDs 7, 11, 51, 52, 153 and 154 raise "Drive failing" | ~~Risk class (Healthy, Attention, High risk, Critical, Unknown) from configurable rules; trends; NVMe counters; correlation with crashes~~ — **most of this was already built when the row was written**: `server/src/services/trends.ts:81` defines the class, `server/src/services/drives.ts` assesses every drive (level, class, the reasons that fired, a projection from `slopePerDay`/`daysUntilEmpty`), raises a `disk-forecast` alert inside seven days and exposes a fleet at-risk list. Left: a scheduled fleet-wide assessment, the console at-risk view, NVMe counters, correlation with crashes | **2** |
| 6 | Boot and recovery | Uptime; event logs | Read-only boot configuration, WinRE status, pending reboot, boot-critical services. Offline (WinPE) investigation is a separate tool, decided later | 3, 6 |
| 7 | Windows Update | History, pending updates, last result | Install security and quality updates (decided); pending reboot; fleet compliance; "who has KB X" | 3 |
| 8 | Configuration drift | Firewall policy drift | Versioned baselines per client and model: services, drivers, updates, allowlisted registry values, tasks, apps. Shows differences; never overwrites | 5 |
| 9 | Cabinet-specific | Scanner checklist, scanner IDs per client, sync tests, watched services | Profiles for the three scanner types (Lumidigm, DigitalPersona, and a third DigitalPersona model to confirm); vendor middleware services; required ports and endpoints. CUBEX and ZIMBIS only through documented interfaces | 3, 4 |
| 10 | Troubleshooting engine | Alerts engine with symptom rules (no regular expressions) | Symptom playbooks: read-only checks first, findings with how sure they are, the fix offered, verification, case notes | 4 |
| 11 | Fleet incident correlation | Alerts across the fleet; unrecognized errors | Grouping by model, Windows build, driver and update; affected and unaffected compared; mass blue-screen view | 2 |
| 12 | History and timelines | Events, commands, alerts, firewall changes, audit log | Daily health snapshot; trends; one timeline per cabinet; retention settings (exist) | 2, 4 |
| 13 | Safe remediation | Typed writes with roles, confirmation levels, damage limits, write pause, safety net, rollback for network and firewall, verification | Restart, updates, time zone, `app.restart`, allowlisted registry values | 3, 4 |
| 14 | Agent and server | All of it: low-privilege network service, broker, mutual TLS, event queue, signed upgrades with rollback | Agent health in the console | 5 |
| 15 | Alerting and maintenance | Severity, deduplication, claim, resolve, suppressions, offline alerts | Maintenance windows; repeated-restart and reboot-loop alerts; USB disconnect alerts | 2, 5 |
| 16 | Reports and case notes | None | Diagnosis report and case notes (Issue, Findings, Actions, Pending, Next steps) to copy into Salesforce, with no patient data | 4 |
| 17 | Advanced diagnostics | Part (event logs, connections in milestone 11) | Defender, BitLocker, certificates, time, power plans, DNS cache, profile changes; ETW only on demand | 6 |
| 18, 46 | UI and accessibility | Brand design system; keyboard and screen-reader support; tested pages | Incident, crash, storage, fleet operations and support call screens as they are built | each |
| 19 | Testing | Contract, unit, end-to-end, real-agent and browser tests; Windows CI | Synthetic fixtures per module (blue screens, disk, DNS, loops) | each |
| 20, 47 | Plan and delivery | This file; 09; 12 | Feature matrix per module, written before it is built | each |
| 21 | Fleet operations and time | Bulk firewall policy (client or site, password, 200 cabinets, one bulk ID) | Fleet operations page (select by client, site or hand-picked cabinets, preview, jobs with per-cabinet results); time zone per site and clock sync | 3, 4 |
| 22 | Registry | None | Read and compare allowlisted keys; write allowlisted values with backup and verification (Tier 2, code) | 5 |
| 23 | Environment variables | None | Read machine variables (values that look like secrets are hidden); compare; no writes at first | 5 |
| 24 | File deployment | Signed packages only | Configuration files as signed packages; file existence, version and hash checks in approved folders | 5 |
| 25 | Software lifecycle | Install signed MSI and driver packages | Inventory; repair and uninstall of approved packages; canary rollouts (reuse the agent rollout code) | 5 |
| 26 | Agent self-recovery | Updater with rollback; watcher | Agent health and crash history; a recovery task that can only restart the agent | 5 |
| 27 | Out-of-band | None | Detect AMT or vPro only. No Wake-on-LAN (excluded by the owner). Later | 6 |
| 28 | Configuration backup | Firewall snapshots | Snapshots of approved settings; compare; restore chosen items | 5 |
| 29 | Before and after snapshots | Firewall before and after; command results | Generalised: the relevant checks run before and after each fix, with a comparison | 4 |
| 30 | Dependency mapping | Watched services; scanner IDs | Dependency profiles per application version: services, drivers, USB devices, ports, files | 5 |
| 31 | Packet capture | None | Admin-started pktmon capture: 60 seconds at most, filtered to one host or port, size-capped, deleted after the retention period | 6 |
| 32 | Performance analysis | Processes (CPU and memory) | Counters for CPU, memory, paging, disk latency and network; bottleneck findings with measurements | 6 |
| 33 | Windows installation health | None | Read-only servicing state; DISM and SFC scans as Tier 2 operations with a code (they are slow and heavy) | 6 |
| 34 | Peripheral reliability | Scanner reconnect counts; scanner events | History and comparison across cabinets | 5 |
| 35 | Power-loss investigation | Kernel-Power 41 and 6008 alerts | Classify bug check, power loss, forced off or unknown, with evidence; UPS only if a documented source exists | 2 |
| 36 | Change tracking | Firewall history; audit log; update history | One timeline of updates, drivers, software, services and network changes, from the time monitoring started | 4 |
| 37 | Primary cabinet protection | Cabinet roles (sync, satellite) | Disruptive bulk operations never hit a site's sync cabinet together with its satellites; extra confirmation for sync cabinets | 3 |
| 38 | Site readiness | None | Per-site checklist built from existing checks; scheduled and on demand; "unknown" never counts as ready | 4 |
| 39 | Evidence preservation | Events and results kept with retention | Evidence bundles, hashed and with their source, built on triggers; uploads that resume (needs the upload decision in 09) | 2 |
| 40 | Site topology | Site sync address; cabinet IPs | Per-site view of addresses, gateways and DNS; "all cabinets at the site went quiet together" detection | 3 |
| 41 | Pre-maintenance checks | Damage limits, write pause, read-only mode, safety net | A generalised preflight check for each disruptive operation | 3 |
| 42 | Incident response mode | Major alerts across the fleet | Incident page: affected and recovered counts, groupings, comparisons, staged recovery | 2 |
| 43 | Support call mode | Cabinet page and jump box | Symptom-first workflow: choose a symptom, run its playbook, apply the fix, get case notes | 4 |
| 44 | Preventive maintenance | Offline, drive and firewall drift alerts | Daily health snapshot (milestone 12); daily and weekly exception reports | 4 |
| 45 | Execution control | Command expiry, replay protection, bulk ID, limits | Job engine with a fixed target list, concurrency, staggering, cancellation and per-cabinet results | 4 |

## Phase 2: blue screens and storage

Built (October 2026):

- **The change watcher** on the agent records system changes as they happen, as `change` events: updates installed, drivers and services installed, software installed or removed, Windows starting and shutting down, and restart requests with who asked. The list of (log, source, event ID) is fixed in the agent; the first look goes back 14 days. So the platform knows what changed before a crash, even when the cabinet cannot boot afterwards.
- **Boots** are recorded from the heartbeat (the uptime went back) and from Windows' own start record, counted once.
- **Reboot loops**: 3 starts within an hour, or 2 starts and then silence within 15 minutes of the last start, raise a major "Restarting repeatedly" alert. A cabinet that simply went offline does not. Two hours of running ends it.
- **Stop codes** are read from BugCheck 1001 messages without patterns, named, and given a hint ("a driver, very often a recently installed one").
- **Crashes and restarts**, on each cabinet: blue screens, unexpected restarts, stop codes, what changed in the 72 hours before the first crash, and the timeline.
- **Incidents**, for the fleet: who crashed, when it began (by hour), still down and restarting, stop codes, where, and what the crashed cabinets have in common compared with the ones that did not crash. A change stands out when it is on half or more of the crashed cabinets and 40 points more often than on the others. Case notes can be copied.

Still to build in this phase:

| Part | What it does |
|---|---|
| Agent operations | `crash.list`: bug check records, dump folder inventory, and minidump metadata parsed on the cabinet (stop code, parameters, faulting module and its version, time). `boot.history`: boots, shutdowns and their kinds, with uptime before each. `storage.health`: SMART, the NVMe health log and volume state. |
| Agent monitors | New dumps, short uptimes and repeated boots raise events. |
| Server | Reboot-loop detection: repeated short uptimes and boots before the cabinet went quiet, kept separate from plain "offline". A crash signature (stop code plus faulting module) groups crashes across the fleet. Storage risk classes come from configurable rules. |
| Console | A crash investigation page per cabinet, with a timeline of updates, driver changes, storage errors and crashes. A fleet incident page that compares affected and unaffected cabinets by model, build, driver and update. |
| Evidence | Minidump upload and packet capture follow the decision in 09: Admin only, encrypted, time-limited and audited. |

## Phase 3: time zone and clock (module 21)

Built (October 2026):

- **Operations.** `time.status` (read, Tier 1): the cabinet's zone, local time, Windows Time's state, source, last successful sync, and whether Group Policy sets it. `time.setZone` (write, Tier 1, a click): only the seven United States zones compiled into the agent, run by the broker as `tzutil.exe /s <zone>`. `time.sync` (write, Tier 1, a click): `w32tm.exe /resync`, never changing the source. Both programs are started by full path with argument arrays.
- **Heartbeat.** Every heartbeat carries the cabinet's zone; its clock offset was already there.
- **Sites.** Each site may set the zone its cabinets should use (Tier 2). A cabinet in another zone gets a minor "Wrong time zone" alert; a clock more than two minutes off gets "Clock is off" (two minutes unless the site, its client or the fleet sets a tighter tolerance, 10 to 120 seconds; decision-log D109). Both close on their own.
- **Console.** A Time section on every cabinet, with the findings and the fixes; the zone setting on the site page.
- **Demo.** Three cabinets in the wrong zone (Arizona, California, Texas) and one drifting clock (New York).

## Cabinet alerts and the one-site rule (October 2026)

- **Cabinet alerts.** An issue type can have the scope "cabinet": its alerts show on that cabinet's page (and its logs) but not in the fleet alert list, the badge count or the client and site counts. The first is "Expected USB device not detected" (a minor alert: the cabinet has USB ports, a fingerprint scanner is expected on one, and nothing is detected on any).
  - **Differs from what the real agent does today:** the agent's scanner monitor reports a scanner that disconnected, with its port. Reporting "nothing is detected on any USB port although a device is expected" (from the cabinet's USB port count and the device list) is an agent monitor still to be written; the platform side (the rule, the scope, the alert and its logs) is built and the demo shows it.
- **Low disk space** (Windows event 2013) is a built-in minor issue type.
- **Bulk changes cover one site** (see [16-network-troubleshooting.md](16-network-troubleshooting.md)).

## Accounts and sign-in (October 2026)

- **Branding.** The console uses the operator’s branding. The sign-in page asks for support team credentials and says nothing about recording; the audit log still records what it must (sign-ins, account changes, cabinet access and every change to a cabinet), but the interface reads like any other web application.
- **Authenticator setup is a QR code** drawn in the browser from the setup link (the key never goes to another service). There is no phone link. The key is behind a collapsed "Cannot scan it?" line for people who cannot scan.
  - Each setup's account label carries a four-letter tag from its secret, for example `sam (JGCA)`, so an account set up again is a different entry in the app from the old one.
  - **Dependency added:** `qrcode-generator` 2.0.4 in the console (MIT, no dependencies of its own), because a QR encoder is not in the standard library and writing one by hand is a risk for no benefit.
- **Deleted usernames.** A deleted account keeps its row, so its username is not free. Creating it again answers `username_deleted`; the console then offers to reactivate that account. An Admin can also list deleted accounts and reactivate one. **Reactivation needs a written reason (3 to 500 characters)** which goes into the audit log (`user.reactivate`) with the username and role; the account comes back active with a new temporary password, no authenticator (set up afresh at first sign-in) and no sessions. Admin only, confirmed with an authenticator code bound to the reason.
- **Usernames** have their own column on the Users page, and the audit log names the actor with their username.

## Fleet operations (modules 21 and 45)

Built (October 2026):

- **Choosing cabinets.** The Fleet operations page lists active cabinets by client, site and problem (wrong time zone, clock off, firewall differs from policy); people tick cabinets one by one or all shown. The selection is kept while moving around the console in the same tab.
- **Operations.** Set each cabinet to its site's time zone, sync clocks, apply the firewall policy. The server fills in each cabinet's parameters; nothing else can be sent.
- **Preview.** What each cabinet would get, and which are skipped and why: offline, read-only, client paused, already right, site has no zone.
- **Confirmation.** The password again; the token is bound to the job's ID and to {operation, cabinets, batch size}. At most 200 cabinets. The fleet and client pauses, the person's own pause and limit apply; one job counts as one write.
- **Jobs.** The target list is fixed when the job starts. Commands go out in batches (1 to 50 at a time); the next batch starts when this one has answered. Each cabinet's result is recorded: skipped, failed (with the agent's reason, or "took the command but did not answer"), offline (out of contact for the whole job: it never took the command, so nothing was changed on it; F18.R2, decision-log D46), verified from the cabinet's next report, "not verified" when its report did not show the change in time, or cancelled. The list of jobs counts failed, not verified and offline as problems. A pause during a job skips the cabinets not yet reached. Jobs survive a server restart. The person who started a job, or an Admin, can cancel the rest. A cancelled job still finishes and verifies the batch it had already sent; until it has ended, its page says "Cancelling: finishing the N cabinets already sent" and keeps refreshing, and it says "Cancelled" once the job has its finish time (decision-log D83).
- **Sync cabinets last** (the owner's decision, October 2026; fleet jobs only). A sync cabinet serves every satellite at its site, so a change that breaks it cuts them all off. In every fleet job, sync cabinets go after all the other cabinets, in batches of their own, and only once every satellite in the job has checked out. If a satellite being changed in the job was not verified (it failed, went unverified, or was left waiting for verification by a server restart), each sync cabinet in it is left unchanged and marked skipped with the satellites named. A standalone cabinet's failure does not hold them back; a job of sync cabinets alone runs as usual. The preview lists them last with "Sync cabinet: last" and says why.
- **Sync cabinet warning** (module 37, the owner's decision, October 2026). Every change confirmed on a sync cabinet's page (the authenticator-code and the one-click confirmations alike) names the satellites that depend on it: "This is the sync cabinet for 2 satellites (EXAM 1, EXAM 2). If this change takes it offline, they lose sync until it is back." The confirmation level is the operation's own; the warning adds no step. The client/site bulk firewall apply keeps applying to every cabinet, sync cabinets included, as the owner decided.
- **Scale, measured against the simulator** (fleet-jobs.test): 10 cabinets in about 0.4 s, 60 in about 0.7 s, 98 in about 1.1 s, every reachable cabinet verified. Real cabinets answer within their poll interval and verify on their next heartbeat (up to a minute).

Still to build: more operations as jobs (updates) once those operations exist; scheduling a job for later. Restarts are never a job operation (the owner's decision, 2026-10-29, for security; 09 "No bulk restarts").

## Evidence and retention (modules 12 and 39)

Built (October 2026):

- **Evidence packages.** On a cabinet's Crashes and restarts section, "Download evidence package": its events, boots, alerts, the commands sent to it and their results, the timeline and the crash analysis for the period, with where each part came from and SHA-256 hashes per section and for the whole; every export is audited with its hash. See [data-classification.md](../platform/data-classification.md).
- **First look.** A newly installed agent reads 30 days back for crash, storage and hardware evidence (24 hours for other errors, 14 days for changes).
- **Retention by class.** Network diagnoses, boot records and fleet jobs now have their own retention settings next to events, command results, alerts and firewall history.
- **Ingest quota.** 3,000 events per cabinet per hour; over it the agent keeps them and sends later.

Still open: minidump upload and packet capture (decision in 09, with safeguards to confirm), evidence for a whole fleet incident in one package.

## The troubleshooting workflow (October 2026)

Built, on top of the symptom workbench, the network diagnosis, known fixes and the crash and drive pages that were already there:

- **Diagnose this cabinet** (Tier 1). One click on the cabinet's Troubleshoot tab. The server issues a fixed list of reads as the person who clicked (each checked and audited like any read): `system.info`, `disk.smart`, `system.performance`, `peripheral.status`, `usb.ports`, `devices.list` (problems only), `services.list`, `updates.status`, `time.status`, and `eventlog.query` for System and Application (errors and critical, last 24 hours), together with the network diagnosis. Fixed checks (`server/src/diagnose/cabinet-findings.ts`, pure, no regular expressions) turn the answers into findings. Each finding has a severity (problem, warning, note), how sure it is (confirmed, probable, possible, could not check), its evidence, the suggested fix, a stable key and a priority; findings are ranked by severity, then certainty, then priority, and one explained by another (an update that failed on a full drive) goes after its cause. A read that did not answer is "could not check", never healthy. Findings link to the built-in issue type they are an instance of, to the runbook and known fixes that apply and to "usually fixed by", and carry a fix button only where a safe catalog operation exists (sync the clock, set the site's time zone, start or enable an essential service, or the network fixes). The run is stored with the diagnoses (30 days). An offline cabinet is refused at once.
- **Runbooks.** Step lists for an issue type or a finding key; a step may carry a read-only check and a one-click fix. The server accepts only catalog reads and writes confirmed by a click (never a code-level change, never anything outside the catalog); parameters must fit the operation's own schema; at most 12 steps, 5 `https` links and 4,000 characters. Tier 2 proposes, an Admin approves with an authenticator code (`runbook.approve`), approving retires the previous one, and retiring brings the platform's own (`runbooks-builtin.ts`, 24 targets) back. A runbook gives no authority: checks and fixes use the normal command path, with the person's role, the write pause, read-only cabinets and the confirmation level. Shown on alerts, on findings and on the Issues page.
- **Resolution notes and case notes.** Resolving an alert records the cause (500 characters) and the fix (an approved known fix of the issue type, or typed; a typed fix can be kept for every cabinet through the existing known-fix approval). They are kept on the alert, written as a case note on the cabinet (who fixed what, how), and counted: "usually fixed by" shows the three fixes that most often resolved the issue type's alerts in the last year, with the last five resolutions. Case notes (Tier 1 and up) are append-only: the database refuses an edit; an Admin can remove the text of one with a reason. The text is never copied into the audit log.
- **Triage queue and error trends.** The queue ranks the fleet's active alerts by issue type with a fixed score and the reasons for it (severity, cabinets, unclaimed, new or rising, same-site pattern, waiting time), says when most of a group sits at one site (look at the site first), and lists the unrecognized errors by log, source and event ID with a sample message. Error trends come from two small tables filled once a night (twenty minutes after retention) from the events of each finished UTC day; a missed night is made up. Marked new (first seen on the last day, with at least three days of history) or rising (the last 7 days more than double the 7 before, and at least 5 events). Per client or fleet-wide, 7, 14 or 30 days. An Admin can update them now (once in ten minutes). The "cabinets" of a window are those of its busiest day. Reached from Alerts, "Triage and trends". An **Open incidents** view lists every incident not yet closed across the fleet (optionally one client), most recently changed first, with its cabinet, area, state and last step; each opens on its cabinet's History tab (decision-log D16).
- **Built since, and differs from the spec:** the connection profile read, per-server DNS resolution and a per-hop traceroute are now agent operations, all Windows code built after this change. `network.config` returns each adapter's Windows network profile (name and public/private/domain category) and the machine WinHTTP proxy (`agent/src/Cabinet.Agent.Windows/NetworkExtras.cs:65-70`, `:109-124`), the hosts file is the read `network.hosts`, per-server DNS resolution is one `network.test` per DNS server the connected adapters use (`server/src/diagnose/network.ts:73`) and the path is the read `network.trace` (`contracts/schemas/operations/network.trace.schema.json`, `agent/src/Cabinet.Agent.Windows/SystemOperations.cs:292`). An operation *named* `network.resolve` does not exist; the lookups it was to carry are served by `network.test`. What is still open is narrower: the network diagnosis raises no "proxy set", "hosts file overrides" or "category is public" finding. Routes and ARP are part of `network.config` in the catalog. Runbooks are structured steps, not one 4,000-character text as the first spec said; the server limits the total text to 4,000 characters.

## Requirements added by the owner (27 October 2026)

These hold for all remaining work and are checked in each pull request.

- **Troubleshoot without remoting in.** The support team must be able to diagnose a wide range of Windows problems from the console alone, including ones nobody has written a rule for yet. Remote screen control stays out of scope (17-phase-7-and-beyond.md, section 5).
- **Drivers belong to their hardware.** Every driver the platform shows is shown on the device it drives (scanner, network adapter, storage controller, USB hub and so on), with its version, date, signer and provider, not only in a separate driver list.
- **Professional copy.** The console reads as a technical tool for a support team: short, precise and neutral, and not over-explained. This applies to every page, demo mode, the first-sign-in tour and the setup wizard.
- **The fingerprint scanner is a per-client choice at enrollment.** A client either uses the scanner or does not:
  - **When it does:** enrollment sets the scanner's hardware IDs, puts its service on the approved and watched lists, and the scanner checks and alerts apply.
  - **When it does not:** none of these apply to that client's cabinets.
  - Built in PR 8b (05-server-spec.md "Fingerprint scanner per client").
- **Engineering standards.** Secure first, scalable, modular and reusable, and clean code that follows best practice. A change that does not meet these is not finished.
- **Phase 7 and beyond.** The owner's list of further phases is kept in 17-phase-7-and-beyond.md. It is not approved or scheduled. Its first group (change-anchored correlation, problem records with grouped alerts, known-error articles, the asset spine, SLOs and MTTR/MTBF, platform observability, canary rings, scale test and rehearsed restore) is server-side and needs no new privilege on a cabinet.

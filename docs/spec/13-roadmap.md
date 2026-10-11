# Roadmap: the October 2026 module list

In October 2026 the product owner listed modules 1 to 47, plus the fleet time zone section of module 21. This file maps each one to what the platform already does, the phase that builds the rest, and how it fits the rules in [02-security-model.md](02-security-model.md) and [CLAUDE.md](../../CLAUDE.md).

Decisions taken with the owner are in [09-open-decisions.md](09-open-decisions.md), under "Demo and the module list".

Order, as chosen by the owner:

1. The demo (done).
2. Blue screens and storage.
3. Network, updates, restarts and time.
4. Fleet operations and the support call workflow.
5. Drift, baselines and reliability.
6. Advanced diagnostics.

## How every module is built

These rules come from the platform's existing rules. They are not new restrictions.

- **Fixed operations only.** Every capability is a fixed, typed operation in the agent's catalog, with a JSON Schema for its parameters and its output. There is no shell and no generic command runner.
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
| 5 | Storage failure monitoring | SMART health; disk event IDs 7, 11, 51, 52, 153 and 154 raise "Drive failing" | Risk class (Healthy, Attention, High risk, Critical, Unknown) from configurable rules; trends; NVMe counters; correlation with crashes | **2** |
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
- **Sites.** Each site may set the zone its cabinets should use (Tier 2). A cabinet in another zone gets a minor "Wrong time zone" alert; a clock more than two minutes off gets "Clock is off". Both close on their own.
- **Console.** A Time section on every cabinet, with the findings and the fixes; the zone setting on the site page.
- **Demo.** Three cabinets in the wrong zone (Arizona, California, Texas) and one drifting clock (New York).

## Cabinet alerts and the one-site rule (October 2026)

- **Cabinet alerts.** An issue type can have the scope "cabinet": its alerts show on that cabinet's page (and its logs) but not in the fleet alert list, the badge count or the client and site counts. The first is "Expected USB device not detected" (a minor alert: the cabinet has USB ports, a fingerprint scanner is expected on one, and nothing is detected on any).
  - **Differs from what the real agent does today:** the agent's scanner monitor reports a scanner that disconnected, with its port. Reporting "nothing is detected on any USB port although a device is expected" (from the cabinet's USB port count and the device list) is an agent monitor still to be written; the platform side (the rule, the scope, the alert and its logs) is built and the demo shows it.
- **Low disk space** (Windows event 2013) is a built-in minor issue type.
- **Bulk changes cover one site** (see [14-network-troubleshooting.md](14-network-troubleshooting.md)).

## Fleet operations (modules 21 and 45)

Built (October 2026):

- **Choosing cabinets.** The Fleet operations page lists active cabinets by client, site and problem (wrong time zone, clock off, firewall differs from policy); people tick cabinets one by one or all shown. The selection is kept while moving around the console in the same tab.
- **Operations.** Set each cabinet to its site's time zone, sync clocks, apply the firewall policy. The server fills in each cabinet's parameters; nothing else can be sent.
- **Preview.** What each cabinet would get, and which are skipped and why: offline, read-only, client paused, already right, site has no zone.
- **Confirmation.** The password again; the token is bound to the job's ID and to {operation, cabinets, batch size}. At most 200 cabinets. The fleet and client pauses, the person's own pause and limit apply; one job counts as one write.
- **Jobs.** The target list is fixed when the job starts. Commands go out in batches (1 to 50 at a time); the next batch starts when this one has answered. Each cabinet's result is recorded: skipped, failed (with the agent's reason or "did not answer"), verified from the cabinet's next report, or "not verified" when its report did not show the change in time. A pause during a job skips the cabinets not yet reached. Jobs survive a server restart. The person who started a job, or an Admin, can cancel the rest.
- **Scale, measured against the simulator** (fleet-jobs.test): 10 cabinets in about 0.4 s, 60 in about 0.7 s, 98 in about 1.1 s, every reachable cabinet verified. Real cabinets answer within their poll interval and verify on their next heartbeat (up to a minute).

Still to build: more operations as jobs (restarts, updates) once those operations exist; scheduling a job for later; sync-cabinet protection (module 37) for disruptive operations.

## Evidence and retention (modules 12 and 39)

Built (October 2026):

- **Evidence packages.** On a cabinet's Crashes and restarts section, "Download evidence package": its events, boots, alerts, the commands sent to it and their results, the timeline and the crash analysis for the period, with where each part came from and SHA-256 hashes per section and for the whole; every export is audited with its hash. See [data-classification.md](../platform/data-classification.md).
- **First look.** A newly installed agent reads 30 days back for crash, storage and hardware evidence (24 hours for other errors, 14 days for changes).
- **Retention by class.** Network diagnoses, boot records and fleet jobs now have their own retention settings next to events, command results, alerts and firewall history.
- **Ingest quota.** 3,000 events per cabinet per hour; over it the agent keeps them and sends later.

Still open: minidump upload and packet capture (decision in 09, with safeguards to confirm), evidence for a whole fleet incident in one package.

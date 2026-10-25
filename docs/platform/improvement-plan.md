# Improvement plan — USB and device monitoring, network and sync diagnosis, rollback integrity, and platform reach

Written October 2026 for the platform owner. This is a plan, not a spec change: nothing here is built until it is built as a milestone with tests, and anything the spec does not answer is listed in §11 for `docs/spec/09-open-decisions.md` rather than guessed at.

Companion material (this repository, `docs/platform/research/2026-10/`):

- `windows-dynamics.md` — Windows 10 vs 11 and PowerShell 5.1 vs 7.x behaviour, build floors, update policy keys, .NET floors, dynamic detection. Every non-obvious claim carries a Microsoft source URL.
- `usb-design-research.md` — Windows notification APIs, stable per-port identity, device → process/service attachment, anti-flap design, pilot acceptance.
- `audit-agent.md`, `audit-network.md`, `audit-server.md` — adversarial read-only audits with `file:line` evidence, severity, failure scenario and smallest correct fix.

Evidence labels used below: **[verified]** = read in the source during this work; **[audit]** = audit finding, code path quoted; **[hypothesis]** = plausible, needs a Windows or fleet reproducer; **[research]** = from the companion research with a cited source.

---

## 1. The one fact that gates everything else

**No new agent capability can reach a cabinet until the upgrade channel works.** `contracts/trust/upgrade/upgrade-keys.json` is `{"version":1,"keys":[],"publishers":[]}` **[verified]** and `server/src/services/releases.ts:72` refuses every proposed release with `no release key is configured` **[audit]**. The server cannot publish a signed release, and an existing agent's compiled trust bundle would reject an unknown key anyway. This was already Phase 2 of the earlier approved plan; it is now a prerequisite, not a phase: **provision the release signing key (public half + approved publisher chain), compile it into a signed agent release, verify the agent's compiled trust, then the upgrade rollout path — before the USB or network work is scheduled for deployment.**

---

## 2. Where the platform stands today (verified baseline)

- Agent catalog: 55 operations, 20 reads + writes; six writes carry `"safetyNet": true` (`network.setIp`, `network.setDns`, `firewall.setProfile`, `firewall.applyPolicy`, `firewall.setRule`, `firewall.restore`) **[verified, `contracts/schemas/operations/catalog.json`]**.
- The two-minute net: after a covered change the agent must reach the server within 120 s or the broker restores the old settings; pending entries are on disk so a restart inside the window still ends in a rollback **[verified, `Writes/SafetyNet.cs`]**.
- USB today: `ScannerWatch` only (fingerprint scanner); reconnect counting exists as a **reported** checklist figure (`peripheral.status` → Kernel-PnP event 410, warns above 3 in 24 h, compiled-in) **[verified]**. `usb.ports` lists hubs/ports/devices with problem codes, read-only.
- Event logs: `EventLogWatch` reads Critical/Error from the allowed logs plus Warnings from ten hardware-health logs, with per-log bookmarks, record-derived IDs, a 5-minute overlap, a 24 h first look (plus 30 days of fixed crash/storage/hardware pairs for System), and a 20-per-source flood cap with a summary event **[verified]**.
- Network: diagnosis exists per cabinet and per site (gateway, DNS, platform, sync cabinet, firewall, baseline comparison, findings with confidence and path position), including loss/min/avg/max/jitter from pings and a trace to four targets; `network.test` accepts up to 20 echo requests **[verified, `docs/spec/16-network-troubleshooting.md`]**.
- Windows Update: `updates.status` (read) and `updates.uninstall` (write) exist; there is **no** check, install, schedule or defer operation **[verified]**.
- Files: `files.list` (one directory, listing only) and `software.list` (both Uninstall registry views, so installed-program versions) exist; there is **no** operation that reads version data from a supplied path **[verified]**.
- The server knows each site's cabinets and each satellite's sync cabinet; nothing on the agent discovers peers **[verified]**.

---

## 3. Workstream A — USB device presence and the processes/services that depend on it

Marco's ask: alert when hardware that was in a USB port is gone, adjustable thresholds (X minutes absent, N disconnects in Y), and — when a device is added — make sure the processes or services it needs are attached.

### A1. Detection design **[research]**

- **Primary**: `CM_Register_Notification` (`CM_NOTIFY_FILTER_TYPE_DEVICEINSTANCE` broad, plus targeted device-interface GUIDs) as a low-latency *invalidation signal* — register first, then enumerate, then deduplicate (Windows documents the register/enumerate race and double observation).
- **Truth**: a reconciled, persisted PnP snapshot (present devnodes, `DEVPKEY_Device_LocationPaths`, parent chain, container ID, problem code, driver service), swept every 5 minutes with per-cabinet jitter and immediately after boot/resume.
- **Corroboration only**: event logs. Kernel-PnP 410 is a *start*, not proof of a physical unplug/replug; do not build the counter on it. Capture real XML on representative builds before assigning meaning to 400/410/411/420/219 and the UMDF IDs, since the Operational channel can be disabled.
- **Never** count a `Win32_DeviceChangeEvent`/`DBT_DEVNODES_CHANGED` hint as a device transition: it carries no identity, and mixed USB/non-USB changes coalesce.
- **State machine**: `unknown → present → suspectAbsent → absent → recovering → present`, with `problem` orthogonal (present but failing). Absence requires a settled snapshot and durable first-absent time (monotonic within a boot, persisted wall clock across restart, boot epoch recorded); recovery clears only after two healthy samples.

### A2. Identity and moved-vs-gone **[research]**

- Separate **device** records (identity: instance ID, VID/PID, optional USB serial with confidence, container ID) from **attachment** records (the port: normalized full location-path list + root controller identity + hub ancestor chain). `Port_#0002.Hub_#0003` is display text, not a permanent port ID.
- A unique, credible serial means the identity follows the device across ports. No serial → the policy is on the **slot**, labelled low confidence. A VID/PID match with two candidates is `ambiguous`, not "moved".
- A dock or hub disappearing produces **one parent incident plus a bounded affected-child list**, not N independent alerts. A device moved to a new socket closes the old slot as `moved` and opens the new one.

### A3. Dependent processes and services — the "attach on add" half **[research]**

- Model typed, operator-approved edges: `physical USB → PnP function → driver service → OS/vendor service or app → functional probe`. The driver service name comes from `DEVPKEY_Device_Service`/`SPDRP_SERVICE`; state comes from SCM `QueryServiceStatusEx`, with dependencies.
- **A running service is not attachment.** Attachment means the approved probe answers *for the current interface/serial*, freshly, twice. "Process running" and "SCM running" are prerequisites only.
- Discovery of "which app uses this device" comes from a signed local manifest / operator pinning, **not** from process names, command lines or handle scraping. No generic handle scraper as the primary oracle.
- **Automatic restart defaults to OFF.** Never auto-restart USB controllers/hubs, disk/network/boot/security drivers, the biometric stack, `svchost`, the agent or broker, or an unknown service. A later phase may allow an exact allowlisted noncritical vendor application service, with a maintenance gate, cooldown and bounded attempts — and never a service name supplied by server rule text.
- Post-repair verification contract: expected identity present + devnode started with no active problem + interface enumerated + SCM state expected + application probe fresh on two samples; otherwise report `repairUnverified` with each layer's evidence and do not loop.

### A4. Adjustable policy (this is the part Marco asked for by name)

Server returns typed policy only; the agent validates locally, keeps the last valid policy when the server is unreachable, and rejects oversized sets (suggested caps: 64 watched units, 16 rules per unit, 64 KiB).

| Setting | Default | Range / meaning |
|---|---|---|
| `absentFor` | 5 min (major for a pinned critical device) | 1–1440 min; off for unpinned unknown devices; timer starts only after a settled snapshot when an expected device or slot was known |
| `reconnectCount` | 3 completed present→absent→present cycles in 60 min (minor) | N 2–20, Y 5–1440 min; scope `device` (strong serial) or `port`; uncertain identity is reported as a lower bound |
| `quietHours` | none | local site time zone; defer *delivery*, keep recording; critical stays visible |
| `severity` | minor reconnect, major sustained absence, informational move | recovery inherits the incident, never a new page |
| settle/debounce | 15 s after a hint, 30 s after resume, 2 snapshots 10 s apart | bounds 2–60 s / 15–300 s / storm grouping 5–120 s |

Where it lives: the existing device-settings pattern (fleet → client → site → cabinet, most specific wins, step-up token, audited) extended with a per-unit pin, and the console's Fingerprint scanner / Devices and drivers / USB ports panels. The compiled `>3 in 24 h` checklist figure becomes the default of the new rule rather than a constant.

### A5. Anti-flap and anti-storm at 8,000 cabinets **[research]**

Bounded callback channel (never block the PnP callback), coalesce hints 2–15 s, one topology walk per burst, one jittered 5-minute sweep, roll ups uploaded at heartbeat and alerts on threshold only, deterministic incident keys `(cabinet, rule, device-or-port key, parent cause)`, one open + one recovery per incident, rate-limited updates, ≤20 child exemplars plus an exact count, explicit `monitorDegraded`/`eventHistoryIncomplete` when telemetry is missing rather than silent health.

### A6. Work items

1. Agent: `UsbTopology` source (collector + identity/location records + persisted snapshot + reconciliation), `UsbHealth` source (declared workload probes). New reads: `usb.topology` (present/historical separation) and `usb.health`; extend `peripheral.status` with per-unit state and policy version. ~M.
2. Server: USB policy settings (schema, validation, resolution, audit, step-up), incident/alert rules for `usb-absent`, `usb-flap`, `usb-moved`, `usb-problem`, recovery auto-resolve, digests. ~M.
3. Console: unit pinning UI, per-unit state panel with last-seen port and the dependency tree, "what changed" history, copy-as-text. ~M.
4. Demo: scenarios for absent, flap, moved, dock cascade, driver failure, app detached. ~S.
5. Tests: malformed/hostile policy, clock jumps, log rollover, channel-disabled, duplicate notifications, restore of a stale snapshot. ~M.
6. Pilot (Windows 10 and Windows 11 real hardware, per the research's acceptance list): unplug/replug, move between ports, dock/hub cascade, identical-unit swap, suspend/resume, service restart, reboot, driver failure, app running but detached. ~S per build.

---

## 4. Workstream B — Network, sync, and packet loss

Marco's ask: when cabinets are not syncing and firewall is not the cause, find out whether packet loss is the cause; make sure any network issue can be worked out; the light data should be able to ping the sync cabinet.

### B1. What exists and the real gap **[audit: `audit-network.md` §10]**

Ping/TCP loss measurement exists, but it is **on demand**: a diagnosis after an outage shows the path *now*, and cannot say whether loss occurred during the lost-sync window, nor separate ICMP filtering from a failing application TCP/TLS path.

### B2. Design — bounded periodic sync-path sampling

- From every satellite, a short, low-bandwidth sample to its **approved same-site sync endpoint** and to the **platform endpoint**: an ICMP echo series where the deployed service is permitted (no elevation needed for .NET `Ping`, subject to Windows policy) **paired with** TCP connects to the known sync port and the actual platform HTTPS port (unprivileged sockets).
- Store per sample: timestamp, endpoint, attempts, successes/timeouts/refusals, RTT min/avg/max/jitter, plus the cabinet's heartbeat/sync state at that time. Correlate sample windows with sync failures so the diagnosis can say "loss during the outage window", not "loss now".
- **Interpretation rules**: ICMP silence with TCP succeeding is inconclusive (filtering), never "loss". TCP-connect failure ratio is not IP packet loss. No replies ⇒ jitter/RTT `null`, not zero.
- **Scan-proof**: reuse the four existing target kinds; the server fills the sync address and ports from the site setting (never the browser); no arbitrary hosts or ports; durable per-cabinet probe budget; jittered cadence; no privileged capture.
- Fixes required first: `network.trace` currently accepts a browser-supplied same-LAN target while `network.test` has its address stripped and refilled (`console-commands.ts:53-63`, `CommandValidator.cs:137-146`) **[audit]**; and the local sync/platform name fallback resolves through the system resolver without re-validating the resolved destination (`NetworkTester.cs:60-67,104-112,251-264,303-315`) **[audit]**.

### B3. Diagnosis integration

New findings on the existing path model (link → address → gateway → DNS → platform → sync cabinet → firewall): loss above a threshold *during* the sync-failure window; sync-port refusal with clean ICMP (application or listener, not the network); clean path with sync failures (look at the listening service with `network.listeners`, the sync cabinet's firewall, or the application itself); asymmetric satellite→sync vs sync→platform. Everything says what was seen and what it often means, with confidence — never a verdict.

### B4. Data-lite mode

Shrink **payload and frequency**, never the alerting contract **[audit: `audit-server.md`]**. Keep: authenticated heartbeat/last-seen, identity and version, command poll/ack/result, critical security events and event cursors, health transitions, incident-triggering event metadata, reboot/crash and disk/availability thresholds. Send inventories, config snapshots, process/service lists and load samples only on change, on incident, or on a bounded on-demand request. Record dropped counts and completeness so a missing sample is never mistaken for health. Sync-path samples are tiny and stay in both modes — that is the "light data pings the sync cabinet" ask. Test both modes against the same alert fixtures.

### B5. Identifying other cabinets

Server-side only, and it is already known: the server holds client/site/sync topology. Anything "peer suggested" returns bounded, ranked, explained summaries from the same client/site with a compatible role/model/software baseline and data freshness, capped (e.g. 20) with totals. **No client-side discovery scanning** — the agent's network surface stays the four bounded targets.

### B6. Work items

1. Agent: periodic sample loop + local budget/state; extend `network.test` or add `network.pathhealth` (read) returning the series; fix trace/DNS validation. ~M.
2. Server: correlate samples with sync/heartbeat state, new observations and findings, retention, no new arbitrary-target surface. ~M.
3. Console: loss *history* on the cabinet Network tab and the site's diagnosis page, with the outage window shaded. ~S.
4. Data-lite mode as a server-directed setting, with tests proving alert parity. ~M.

---

## 5. Workstream C — Version data from file paths

Marco's ask: supply file paths and pull read data, so we can get things like application versions.

- New read `files.facts`. **Who may set the paths**: a server administrator/deployment owner only, as a signed, versioned per-application allowlist (exact paths, or canonical roots plus fixed relative names), set at fleet/client/site/cabinet level through the existing device-settings route with step-up and audit. Tier 1/Tier 2 and agents never submit paths.
- **What comes back**: metadata only — product/file version, company, description, size, last-write time, Authenticode status, optionally SHA-256. Never file content. Version resources are evidence of a file, not proof an application works.
- Validation: canonicalize, reject absolute/traversal/UNC/device/alternate-stream forms, refuse or safely resolve reparse points/junctions/symlinks, verify the opened handle stays inside the approved root (lexical prefix checks are insufficient), no recursion, no network shares, per-file and aggregate byte caps, bounded count, timeouts, no check-then-open gap **[audit: `audit-server.md` design requirements]**.
- Return path identifier + normalized version + observed time + bounded status; redact secrets; audit each request and per-path outcome; rate-limit; schema-cap the response; treat cabinet-reported values as untrusted telemetry bound to the authenticated cabinet.
- Console: an "Application versions" panel (from `files.facts` + `software.list`) and a rule that raises when a tracked version differs from the site baseline — which reuses the baseline/drift machinery that already works **[verified]**.

---

## 6. Workstream D — Windows Update: check, schedule, defer **[research: `windows-dynamics.md`]**

- New operations, broker-scoped, typed and bounded: `updates.check` (WUA search with accepted classifications), `updates.install` (a selected/approved set, explicit about source, progress, timeout, reboot policy), `updates.policy` (deferral/active hours/target release **where documented for that build**). WUA COM (`IUpdateSearcher`/`IUpdateDownloader`/`IUpdateInstaller`) is the supported interface; "unavailable" must never be reported as "up to date".
- **Registry is not a portable policy API.** Prefer the managed interface; snapshot policy values (existence, type, data, conflicting AU/WSUS keys) *before* change, record the owner, set the expiry in durable broker state before writing, read back the *effective* value and WUA behaviour, restore exactly, recheck after Group Policy refresh/reboot and mark `superseded` rather than fighting enterprise management.
- Build floors to gate on (not guessed): deferrals and active hours from 1607/14393, `ActiveHoursMaxRange` from 1703/15063, target release from 1803 (17134.1488) / 1809 (17763.1217) / 1903 (18362.836) with `ProductVersion` 19041.1202 or 22000, quality-update deadlines from 1903, Windows 11 22H2+ separate feature/quality no-auto-reboot deadlines. No documented target-release support on 14393: use approval/maintenance rather than a pretend registry pin. Active hours max 12 h on 1607, 18 h later.
- **Reboot discipline**: a deadline can restart a cabinet during active hours and `NoAutoRebootWithLoggedOnUsers` is not a universal guarantee. Surface pending restart and deadline in the console, keep the agent's own scheduled restart separate and human-approved, and never claim WU scheduling equals `system.restart`.
- Alerting: pending restart beyond a window, update failures, and repeated update attempts feed the existing alert model.

---

## 7. Workstream E — Rollback and self-preservation (fix before new features)

Marco's ask: when firewall or other policy breaks its connection to the server, it needs to roll itself back. The net exists; the audits show where it leaks. **I re-read the first five of these myself and confirmed them in the source [verified].**

1. **Failed rollback is recorded as success and never retried** — `Writes/SafetyNet.cs:112-125`: the catch logs, then `Pending.Remove(e); Record(..., RolledBack)`. **Critical.** Fix: retain the entry with a `rollbackFailed` state, retry (bounded), only record `RolledBack` after the saved state is restored *and read back*, and surface the failure as its own security event.
2. **Confirm ignores the deadline** — `SafetyNet.cs:75-93`: a confirmation arriving after 120 s but before the 5-second upkeep keeps the change. **High.** Fix: compare the deadline inside the same lock; expired ⇒ roll back and report that.
3. **Changes are applied before rollback protection is durable** — `Writes/BrokerWrites.cs:103-108` (and 49-53, 138-145, 167-182, 213-226, 238-241): mutation first, `Arm` afterwards; `SetDns`/`Restore` do not even call `ArmIfPartlyApplied`. **High.** Fix: write the pre-change intent/after-state durably *before* the mutation, transition it after applying, and restore or keep retrying on any failure.
4. **Firewall reenable timers are removed before the reenable succeeds** — `Writes/FirewallStore.cs:101-111` + `BrokerWrites.cs:264-276`. **High.** Fix: keep due timers durable until a verified reenable, then remove.
5. **A bare server response keeps a bad change** — `Server/AgentConnection.cs:715-735`: `BadRequest`/`NotFound`/`Conflict` set `reached = true` (bound to the "the server answered" comment) and the outbox is marked delivered, so a refused result can still confirm/keep a change. **High.** Fix: confirm only an accepted, authenticated result for that command (or a verified duplicate) and keep refusals unsettled.
6. **Unreadable safety-net state silently becomes empty** — `Monitoring/StateFile.cs:19-25` returns `new T()` on any read error; `SafetyNet` uses it for pending rollbacks. **High.** Fix: fail closed on critical state, keep a recoverable previous copy, alert; reserve fresh-state fallback for non-safety caches.
7. **Coverage boundary to make explicit**: the net covers six operations **per cabinet**, not a site-wide change as one transaction; `network.renewLease` can release the only working lease with no undo; service start-type updates, installs, `updates.uninstall` and any future hosts/proxy/Update-policy/task writes carry no net **[audit]**. Decide per write whether it must carry a net (connectivity-affecting ⇒ yes) and implement it there, rather than leaving the boundary implicit.
8. **Bulk application safety**: `DEFAULT_POLICY = {domain:"off", private:"off", public:"off"}` and batches include the site's sync cabinet without a role/order guard (`firewall-policy.ts:19,125-173`, `fleet-jobs.ts:68-78,99-103,210-249`) **[audit]** — a blanket apply can cut off a sync cabinet's satellites while the sync cabinet itself still reaches the platform, so its change is confirmed and kept. Fix: order/exclude the sync cabinet, verify satellite→sync connectivity before declaring a batch safe, and report per-cabinet final states (some targets can be failed/offline/unverified/cancelled — a job `done` is not a uniform applied outcome) **[audit]**.
9. **Local recovery, not just rollback**: a bounded broker-side watchdog — if the platform has been unreachable for N minutes and the journal shows a recent platform-caused connectivity change, self-revert the newest such change once, report it, and never loop.
10. **Either include the "resolving open alerts when a cabinet is removed" fix from `docs/spec/09-open-decisions.md`, or state why it stays out.**

Also in this workstream, from the agent audit (fix-first list): broker-side provenance/authorization for privileged requests (`BrokerProtocol.cs:154-168` — the pipe authenticates the caller account but does not verify that this is an authorized, non-replayable server command) **[audit]**; installer staging/ACL/signature verification and transactional install with identity preservation (`Install-CabinetAgent.ps1:23,56-65,99-101,161-199`) **[audit]**; upgrader failure finality (`Upgrades/Updater.cs:126-127,185-196`) **[audit]**; outbox ordering on delivery/requeue (`Server/ResultOutbox.cs:98-105,133-143`) **[audit]**; required CA fingerprint on install (`Install-CabinetAgent.ps1:75-80`) **[audit]**; honest uninstall error checking (`Uninstall-CabinetAgent.ps1:11-26`) **[audit]**.

---

## 8. Workstream F — Reach: Windows 10 and 11, every PowerShell, as many machines as possible

Marco's ask: this must work on Windows 10 and 11 and various PowerShell versions for things like deployment scripts, and on as many machines as possible.

- **.NET floor**: .NET 8/9/10 all list Windows 10 1607 (build 14393) Enterprise/LTSC as the earliest supported Windows 10 target; self-contained publishing bundles the runtime but does not lower the OS floor or extend OS lifecycle. 14393 is the documented *support* floor, **not** a proven loader minimum — the exact hard minimum is unconfirmed **[research]**. Choose build families with the owner (x64 primary; x86/Arm64 only if the estate needs them), and smoke-test each family on real cabinets.
- **PowerShell**: launch the engine by full path, check `PSEdition`/`PSVersion`/`Is64BitProcess`/`LanguageMode`/module inventory; keep shared scripts **PS 5.1-parseable** (no `??`, `?.`, ternary, `&&`/`||`, parallel `ForEach-Object`); `Get-CimInstance` instead of `Get-WmiObject` (absent in 7); `Test-Connection` parameter differences and `Test-NetConnection` being a Windows module — use .NET `Ping.SendPingAsync`/`TcpClient` with explicit timeouts for bounded measurements; TLS 1.2 selection only where an old Framework needs it, never lowering server TLS; explicit **PowerShell 7 requirement** for the release/signing scripts, which currently call `ImportFromPem`, `[Convert]::ToHexString` and `-Encoding utf8NoBOM` with no version guard (`New-UpgradeTrust.ps1`, `New-AgentRelease.ps1`) **[audit]**.
- **Security tooling**: WDAC/App Control can force scripts into `ConstrainedLanguage` even when execution policy permits; Defender ASR (obfuscated scripts from 1709, PSExec/WMI-origin child processes from 1803) can block scripted deployment; on 1607 LTSB the `Disabled:Script Enforcement` option is unsupported. Check app-control/ASR state and protection events before a deployment rather than advising anyone to disable Defender **[research]**.
- **Bitness/paths**: run elevated scripts as 64-bit only, use canonical absolute paths (`$env:SystemRoot\System32\...` from the 64-bit process, `Sysnative` awareness), long-path support requires both the policy and a `longPathAware` manifest **[research]**.
- **Installer**: preflight, stage into an administrator-only directory, verify ACLs and signatures *there*, swap with a retained previous version, restore on failure, and **preserve cabinet identity** on repair/upgrade unless re-enrollment is explicit **[audit]**.
- **Estate measurement**: the platform already reads OS and hardware (`system.info`, `system.hardware`) — add a console compatibility report (build/UBR/edition/architecture distribution, app-control state, WUA source) so "as many machines as possible" becomes a measured target with a published supported matrix, and a real-cabinet smoke test per build family as the acceptance gate.

---

## 9. Workstream G — Platform scale and integrity for 8,000 cabinets **[audit: `audit-server.md`]**

- Concurrent release uploads share one temp filename (`releases.ts:163-180`): unique exclusive temp file, verify the on-disk artifact, publish under a per-version lock, and check the conditional update's row count (and `added_by`) inside the same transaction as the final transition.
- Full audit-chain verification does not detect a deleted suffix (`db.ts:370-399`): verify against an independently protected high-water mark, not only the rows found.
- Automatic site-outage resolution and security-alert repeat updates write no audit entry (`site-outage.ts:43-55`, `security.ts:27-37`); retention deletes before auditing its run (`maintenance.ts:149-181`) — make destructive/automatic transitions auditable in the same transaction.
- Unpaginated site/cabinet detail (`fleet.ts:65,79-96`) and a fleet-wide reading search that ranks every stored result (`readings.ts:155-167`): paginate/keyset, aggregate alert counts once, keep a per-cabinet/per-operation latest-read projection, and put a fleet-wide concurrency budget on searches and on-demand chain verification.

---

## 10. Sequence, sizes, and gates

Ordered by dependency and risk; each item is a milestone of its own with tests for malformed and hostile input, and no new dependency without a stated reason (repository rules).

| Order | Work | Size | Why here |
|---|---|---|---|
| 0 | Upgrade channel: real release key + publisher chain, verify compiled trust | S–M | Nothing else can ship without it |
| 1 | Rollback integrity: §7 items 1–6, 8, plus the agent-audit fix-first list | M–L | Safety of every later write |
| 2 | USB: presence + dependent workload + adjustable policy (§3, A6 items 1–5) | L | The ask; biggest owner-visible win |
| 3 | Sync-path sampling and packet-loss history (§4) | M | Answers the "not the firewall" case |
| 4 | File facts / application versions (§5) | M | Small, high owner value, needs §7 first |
| 5 | Windows Update check/install/schedule/defer (§6) | L | Highest blast radius; needs §7 and the build gates |
| 6 | Reach: PowerShell/bitness/installer work + estate compatibility report (§8) | M | Turns coverage into a measured number |
| 7 | Scale and integrity for 8k (§9) | M | Needed before the estate grows |
| 8 | Data-lite mode (§4 B4), peers (§4 B5), pilot campaigns on Win10/Win11 hardware | S–M each | Last, on facts |

Gates for every item: schema validation before any other code; tests including malformed/hostile input; real-cabinet verification where Windows behaviour is claimed; explicit statement of what was not tested; no Windows behaviour asserted from Linux test results alone.

---

## 11. Questions for `docs/spec/09-open-decisions.md` (spec does not answer these)

1. Does a USB *slot* policy or a *device* policy win when a scanner with a credible serial is found on a different port? Proposed: device identity wins, slot warns.
2. Which writes must carry a safety net? Proposed rule: any write that can affect the platform connection (address, DNS, firewall, proxy/hosts if ever added, service start type of a network service, update policy that could restart or re-route traffic).
3. May the agent restart an allowlisted vendor application service to re-attach a device, or is that always a human action? Proposed: human until a pilot proves the probe contract.
4. Is the file-facts allowlist owned by the deployment owner at fleet level, or may a client-level admin set it? Proposed: fleet level, admin-set with step-up, signed and versioned.
5. Data-lite: is it a per-cabinet, per-site or global setting, and who may switch it?
6. Where does "expected application version" live — the existing baseline/drift model, or a new expectation type?
7. Peer suggestions: does the fleet-wide read model (every support person sees every client) hold for this, or does it need grants first?
8. CA private key on the server disk against spec (still pending from earlier work): record the decision, not just the fact.

---

## 12. Limits of this work

- Everything here is source-level. No Windows cabinet, no live write, and no platform database write was used: the 18 never-exercised live writes stay unexercised.
- The audits are static inspection: ACL races, 32-bit redirection, PowerShell 5.1 runtime failures under WDAC/ASR, hung-WMI behaviour and USB notification behaviour on real builds are **hypotheses until run on disposable Windows 10 and Windows 11 machines**.
- The USB policy defaults, thresholds and anti-storm figures are engineering proposals for a pilot, not measured fleet values; the research marks them as unconfirmed.
- The Windows compatibility claims carry Microsoft source URLs in `windows-dynamics.md`; where no authoritative source exists (hard .NET loader minimum, a cross-build Kernel-PnP 410/420 contract, universal port-location stability), the research says so rather than asserting one.

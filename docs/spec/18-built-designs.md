# 18. Built designs

The designs below are built. Code, tests and contracts cite them for why they are shaped as they are. Each was first written
as a working plan in `docs/platform/` (October 2026). Those plans were removed on 2026-11-25 (decision-log D150); the full text
is in git history. What each section keeps is the decision and its reasons, not the session-by-session status.

## §1 The second Windows architecture (32-bit)

**One source tree, two builds.** Windows cannot run a 64-bit program on 32-bit Windows, and a .NET self-contained build carries
the architecture it was published for. A 32-bit cabinet therefore needs a 32-bit archive of the same agent: same version,
same operations, same signing flow. The code needs no change; all four programs publish for `win-x86` as they are.

- **Two archives per version.** `Publish-CabinetAgent.ps1` and `New-AgentRelease.ps1` take `-Architecture`. The release script
  reads each program's PE machine and refuses a build that is not that architecture; it does not trust the folder name. A
  release is complete only when both archives exist for the same version.
- **On the wire.** `architecture` is `windows-x64` or `windows-x86`, nothing else. It is on the heartbeat and on the enrolment
  request, both optional, because an older agent sends neither. It means the architecture of the agent programs installed
  on that cabinet, the one an update has to match. It is never guessed from the OS name or the machine model.
- **An update never crosses architectures.**
  - The architecture is **not** on the signed manifest. The manifest schema is closed, and an older agent validates it with
    the copy it was built with, so a new field would make every older cabinet refuse every update.
  - It is on the **release record**. The server derives it from the archive's own programs at upload and refuses a package
    that is mixed, unreadable, built for another machine, or not a release layout (`package-architecture.ts`).
  - `startRollout` and `offerFor` skip cabinets of the other architecture and count them. A cabinet that never reported one
    counts as 64-bit, the only build that has ever shipped.
  - The cabinet checks for itself: the updater reads the PE machine of the downloaded programs and refuses a mismatch as a
    failed update. The server's match is convenience; the cabinet's check is the protection.
- **Two artifacts, not interchangeable.** The installer bundle (`CabinetAgent/{install,out}`) and a release package (one folder
  per program at the zip root, what `AgentLayout.ReleasePrograms` looks up) are different trees. The store refuses an
  installer bundle at upload (`package_not_a_release`).
- **Setup.** An architecture picker beside the PowerShell engine picker; the default is 64-bit. The help asks the machine, not
  the shell: `$env:PROCESSOR_ARCHITECTURE` answers `x86` from a 32-bit PowerShell on 64-bit Windows.
- **Registry.** The installer and the updater read `HKLM\SOFTWARE` in the 64-bit view, so both PowerShells find the same install.
- **Not done.** ARM64 is refused politely, nothing more. The acceptance on a real 32-bit cabinet is a hardware gate
  (docs/platform/plan-to-completion.md).

## §2 The diagnostic engine foundation

**Decisions (2026-10-25).**
1. Orchestration runs on the agent: a signed, versioned module of catalog reads plus deterministic rules, held in the bounded
   outbox. The server keeps the rules, the policy and every approval. Repairs always need the server: no offline repair.
2. A per-incident approval is a server record naming the endpoint, the operation, the target and an expiry. Executing it
   still needs that operation's own confirmation level.
3. Device restart and disable/enable, DISM, SFC and scheduled-task changes may join the catalog: Tier 2 with a code, each with
   its own schema, tests and console button in its own phase.
4. Windows Update keeps "never automatic uninstall".
5. Tenant isolation stays as it is: one organization, one console, everything visible to the support roles. A client filter
   is a convenience, not a boundary. One client's data never travels inside another client's evidence package.
6. Encryption at rest is disk encryption at the host, plus passphrase-encrypted export bundles.
7. The login-free TDS pre-login is allowed against a target an Admin configured. No credential is stored or used, and it is
   never a connection to the cabinet application's database.

**Why a foundation at all.** Agent monitors are compiled in, so a new check needs an agent release; `diagnose/*` findings were
code, so a rule change was a server deployment; and "fixed" meant two things (alert resolved, fleet operation verified).
Module data and one incident record answer all three.

**The foundation, item by item.**
1. **Module contract** (`contracts/schemas/diagnostics/module.schema.json`, `server/src/diagnose/module.ts`): applicability
   (roles, hardware, Windows versions as ranges; not clients, see 09-open-decisions.md "Diagnostic modules and clients"),
   signals, procedure (ordered checks, each a catalog read or a pure rule), evidence and retention, hypotheses with
   confidence, remediation (catalog operations only, with preconditions), verification, limits and escalation.
2. **The incident record** (migration `0017_incidents.sql`, `server/src/services/incidents.ts`): one row joining symptom,
   evidence, hypothesis, proposed repair, approval, execution and verification, linked to its alerts, findings, commands and
   case notes, one audit entry per step. A diagnosis that finds a problem opens one (D16).
3. **The capability registry, as data** (`contracts/schemas/diagnostics/registry.schema.json`, `contracts/diagnostics/registry.json`,
   `server/src/diagnose/registry.ts`): capability (detect, diagnose, repair, verify), version, dependencies, workflow chain and
   phase. Supported hardware is the module's own applicability, not a second copy.
4. **The existing findings as modules, behaviour unchanged**: nine cabinet modules (`contracts/diagnostics/modules/cabinet-*.json`,
   run through `CABINET_RULES`) and the network diagnosis (`network-diagnosis.json`, `server/src/diagnose/network-module.ts`).
   The proof is the same reads giving the same findings, with the old tests unchanged.
5. **Tests alongside**: schema validation with malformed and hostile input, and the contract's refusals (an unknown read, a
   missing signal, a module claiming a repair it cannot verify).
6. **Console**: incidents where a person already looks. The cabinet's History tab, Triage's open incidents, and the crash
   incident page (D21). Read only, Tier 1 and up.

**The engine's phases against the roadmap's.** The registry's `phase` field is the engine phase that builds a capability.
The engine's six phases are the roadmap's phases split a second way, not extra phases:

| Engine phase | Roadmap phase |
|---|---|
| 1. Foundation (module contract, incident record, capability registry, findings as modules) | the first slice of 2 |
| 2. Drivers and services | 2, with its phase 3 device work |
| 3. Network and application | 3 |
| 4. Controlled remediation | 4 |
| 5. Extended | 5 |
| 6. Intelligence | 6 |

## §3 Network targets, and no background sampling

**Decided 2026-11-25 (D150): no periodic sampling.** A server half was built for a satellite to sample loss to its sync cabinet
and the platform on a schedule. The owner removed it: with the cabinet firewalls off, a sync failure is not worth a standing
probe. The network diagnosis stays on demand (docs/spec/16-network-troubleshooting.md). A person runs it when something is wrong.

What stays from the design, because the on-demand tests rely on it:
- **Never a scanner.**
  - Only the four existing target kinds.
  - The server fills the sync address and ports from the site setting, never the browser.
  - No arbitrary hosts or ports, and no privileged capture.
  - Two holes this closed: `network.trace` took a browser-supplied LAN target where `network.test` refilled it on the
    server; and a fallback sync or platform *name* resolved through the system resolver without the resolved address being
    checked again.
- **Reading a test.**
  - ICMP silence with TCP succeeding is inconclusive (filtering), never "loss".
  - A TCP connect failure ratio is not IP packet loss.
  - No replies means jitter and RTT are null, not zero.
- **Peers** are suggested by the server only, from topology it already holds. The agent does no discovery scanning.

## §4 The file-facts read

Application versions from named file paths, without a general file read.

- **Who sets the paths.** A server administrator only. A versioned per-application allowlist of exact paths, or canonical roots
  plus fixed relative names, set at fleet, client, site or cabinet level with step-up and audit. Tier 1, Tier 2 and agents
  never submit a path.
- **What comes back.** Metadata only: product and file version, company, description, size, last-write time, Authenticode status,
  optionally SHA-256. Never file content. A version resource is evidence of a file, not proof the application works.
- **Path rules.**
  - Canonicalise, then reject absolute, traversal, UNC, device and alternate-stream forms.
  - Refuse or safely resolve reparse points, junctions and symlinks, and check that the opened handle stays inside the
    approved root. A lexical prefix check is not enough.
  - No recursion and no network shares.
  - Per-file and total byte caps, a bounded count, timeouts, and no gap between the check and the open.
- **Handling.** Return a path identifier, a normalised version, the observed time and a bounded status. Audit each request and
  each path's outcome, rate-limit, cap the response by schema, and treat reported values as untrusted telemetry bound to the
  authenticated cabinet.
- **Console.** An application-versions panel, and drift from the site baseline through the existing baseline machinery.

## §5 USB device watch

**Policy contract.**
- **Delivery.** The server returns typed policy data only. The agent validates it locally, rejects an invalid or oversized
  set, and keeps the last valid policy while the server is unreachable.
- **Resolution.** Global, then site, then cabinet, then an exact pinned unit or slot. `enabled`, `severity`, `scope`,
  schedule and time zone, `version` and the effective time are explicit, never inferred from an absent field.
- **Caps.** 64 watched units, 16 rules per unit, 64 KiB; anything beyond fails validation. These are product choices for
  the pilot, not Microsoft guidance.

| Rule | Default | Bounds |
|---|---|---|
| `absentFor` | 5 min, major, for a pinned critical scanner; off for unpinned unknown devices | 1 to 1440 min. Counts only for a device or slot that was known; persists first-absent time and boot epoch; recovery needs 2 healthy samples 30 s apart |
| `reconnectCount` | 3 completed present-absent-present cycles in 60 min, minor | N 2 to 20, window 5 to 1440 min; per device (strong serial only) or per port. First enumeration, function-child duplicates and boot or resume replay are not counted |
| `quietHours` | none | Site zone, start and end minutes, weekdays. Defers delivery only; never resets a timer or a count |
| `severity` | minor reconnect, major sustained critical absence, informational move | informational, minor, major, critical (critical only through an approved business-impact mapping) |
| settle and debounce | 15 s after a hint, 30 s after resume, 2 snapshots 10 s apart, at most 120 s | debounce 2 to 60 s, resume 15 to 300 s, parent-storm grouping 5 to 120 s |

States: `unknown`, `present`, `suspectAbsent`, `absent`, `recovering`; `problem` is separate (present, but failing). Durations
compare monotonic time within a boot and UTC across restarts; an implausible clock jump is clamped and marked uncertain. A
suppression has an expiry and a reason, and never erases evidence.

**Against flapping and storms at 8,000 cabinets.**
- **Agent.**
  - Notifications go to a bounded channel and hints are coalesced over 2 to 15 s, giving one topology walk per burst.
  - A full sweep runs every 5 minutes with per-cabinet jitter, and at once after resume or restart.
  - A hub or dock outage is one parent incident with a bounded list of affected children.
  - On overflow or timeout the agent reports `monitorDegraded` and rescans. Missing telemetry is never read as healthy.
- **Server.**
  - The incident key is (cabinet, rule, physical or port key, parent cause), and retries deduplicate on immutable IDs.
  - One open and one recovery per incident, with rate-limited updates and a capped child list (20 examples plus the exact
    count).
  - Many cabinets on the same dock, firmware or rollout correlate at the site without hiding each cabinet's state.
  - Rollups go up at heartbeat; an alert goes up on its threshold.

## §6 The server's side of a control request

A control request (`service.control`, `process.end`) names an approved-list **entry key**, never a raw process ID or service
name. Step-up is bound to that exact entry, and every request writes one audit row with its outcome
(`server/src/console-api/control-routes.ts`). This takes the platform from "the cabinet would refuse" to "the platform can ask".

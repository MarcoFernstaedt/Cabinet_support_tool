# Windows Diagnostic and Recovery Engine: audit and plan

October 2026. Audit of the repository against the brief, before any architectural change. Nothing in this document is built yet.

## 1. What the repository already is

| Layer | Technology | Where |
|---|---|---|
| Endpoint agent | C# (.NET 10), network service plus a locked-down broker service; fixed operation catalog; schema-validated input; leased command delivery; durable result outbox | `agent/src/*` |
| Server | Node/TypeScript, SQL Server 2022, agent API (mTLS) and console API | `server/src/*` |
| Console | React/TypeScript, desktop only | `console/` |
| Contracts | JSON Schemas for every operation and envelope, generated types | `contracts/` |
| Spec | Source of truth | `docs/spec/` |

## 2. The brief against what exists

| Brief component | Exists today | Gap |
|---|---|---|
| Event Collector | Agent monitors (scanner, services, event log, storage, USB, time, firewall) raise events into a durable bounded queue; server stores them 90 days | Monitors are fixed code, not pluggable modules; no driver install or Plug and Play change feed |
| Health Monitor | Heartbeat carries load samples; SMART snapshots daily; watched services with auto-restart and an alert after 3 failures | No performance baselines, no sustained-threshold logic |
| Diagnostic Orchestrator | **Server-side**: "Diagnose this cabinet" and network diagnosis send fixed read-only operations and rank findings (`server/src/diagnose/*`) | Orchestration lives on the server, so a diagnosis needs the cabinet reachable |
| Rule Engine | Deterministic rules on fields and plain phrases, never regular expressions (`rules.ts`); findings carry certainty (confirmed, probable, possible, not checked) | Findings are code, not versioned data; no module contract |
| Correlation Engine | Alert folding, site-wide patterns, crash incidents (what crashed cabinets have in common), reboot loops, site outages, error trends | Not per-cabinet cross-signal (driver event plus service plus device status); no recurrence analysis per component |
| Policy Engine | Roles (Tier 1, Tier 2, Admin), per-operation minimum role, confirmation levels (click, authenticator code bound to exact parameters, password for bulk), write pause, fleet safety, rate limits, firewall and connectivity safety net | Policy is per operation and per person; no per-incident approval with expiry for a proposed repair |
| Remediation Executor | Catalog writes (service control, start type, device settings, USB power, DHCP renew, firewall policy, time, package install, driver uninstall) run by the agent or broker with validated parameters | No device restart or disable/enable operation; no DISM or SFC; no scheduled-task operations |
| Verification Engine | Fleet operations verify each change by reading it back; time and firewall fixes re-read | No functional verification (for example "scanner responds"); success is a read-back of settings |
| Incident Manager | Alerts (claim, resolve, notes, resolutions, known fixes), runbooks, case notes, crash incidents, audit chain | No single incident record joining symptom, evidence, hypothesis, proposed repair, approval, execution and verification |

## 3. Rules that the brief meets head-on

These are fixed by `CLAUDE.md` and the security model; the plan follows them and does not bend them.

1. **No arbitrary commands.** The brief agrees: remediation is only a fixed catalog of allowlisted operations. Every new repair is a new catalog operation with a schema.
2. **No Windows Security log.** Section I of the brief asks for "relevant security-related Windows events". The platform never reads the Security log. The security module will use Defender, firewall, service and System/Application log events only.
3. **Rules without regular expressions.** Diagnostic rules stay field and phrase based.
4. **No general file transfer.** Evidence collected is structured readings and bounded excerpts, never file contents.
5. **Broker never networks; the network process is never privileged.** DISM, SFC and device restarts run in the broker, launched by full path with argument arrays, never through a shell.
6. **Do not add dependencies without saying why.**
7. **The agent runs only catalog operations.** An on-agent orchestrator may sequence only catalog operations that the server could have sent. It is not a second way to run anything.

## 4. Decisions needed from you

1. **Where does orchestration run?** The brief wants local, offline-capable diagnostics. Today diagnosis is server-driven. Recommended: keep the server as the authority for rules, policy and approvals, and add an agent-side **evidence runner** that executes a signed, versioned diagnostic module (a list of catalog reads plus the deterministic rules) when a trigger fires, stores the result in the bounded outbox and uploads it when connected. Repairs always need the server's approval, so offline repair is not offered.
2. **Is a per-incident approval (endpoint, operation, target, expiry) enough in place of today's per-action authenticator code?** Recommended: an approval is a server record; executing it still needs the existing confirmation level for that operation.
3. **Device restart and disable/enable, DISM and SFC, scheduled-task changes**: each is a privileged operation that is new to the catalog. Confirm these may be added (all Tier 2, authenticator code, protected-device list for the scanner class only at first).
4. **Windows Update**: keep "never automatic uninstall" (an uninstall already exists as a manual, authenticator-confirmed action).

## 5. Phased plan

Each phase ends with passing tests, documentation, and a review before the next starts. Nothing is merged to `main` without your say.

| Phase | Deliverable | Reuses |
|---|---|---|
| 1. Foundation | Module contract (applicability, signals, procedure, evidence, hypotheses with confidence, remediation, verification, limits, escalation) as TypeScript types and JSON Schema; unified **incident record** and table (migration) with evidence links; audit entries per step; existing findings re-expressed as modules without changing behaviour | `diagnose/*`, alerts, audit |
| 2. Drivers and services | Plug and Play change events, device history; functional verification contract ("verified", "failed", "incomplete: vendor has no test"); device restart and disable/enable operations; service dependency and crash-loop diagnosis; protected services list | peripheral.status, devices.list, services.list, watched services |
| 3. Network and application | Connectivity layering (already built) wrapped as modules; application crash and hung-process detection from Application log events and process reads; recurring crash correlation | network diagnosis, crashes, processes.list |
| 4. Controlled remediation | Remediation registry (operation, preconditions, cooldown, retry limit, rollback, verification), per-incident approval with expiry, loop prevention, escalation | commands, step-up, safety net |
| 5. Extended | Storage, performance baselines, Windows Update, integrity (DISM, SFC), security (no Security log), permissions (read-only ACL evidence), scheduled tasks | SMART trends, system.performance, updates.status |
| 6. Intelligence | Baselines, recurrence analysis, optional AI explanation that only reads incident records and cannot call operations | error trends, triage |

## 6. What cannot be tested here

Plug and Play, SetupAPI, DISM, SFC and device restarts are Windows-only runtime code. They are written to compile and are covered by simulated-failure tests and the Windows CI job, never run against a real device here (the brief forbids disrupting a workstation). A real-agent test is still needed before use.

## 7. Weaknesses that would affect this work

- Agent monitors are compiled in, so adding a diagnostic module needs an agent release (the update channel exists).
- `diagnose/*` findings are code, so a rule change is a server deployment. Versioned module data would avoid this.
- Two separate notions of "fixed" exist (alert resolved, fleet operation verified). The incident record in phase 1 unifies them.

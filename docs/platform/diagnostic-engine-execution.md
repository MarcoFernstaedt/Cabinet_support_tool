# Diagnostic engine: execution plan

2026-10-25. The seven decisions parked in [diagnostic-engine-audit.md](diagnostic-engine-audit.md) are answered. This is
the order the engine is built in, the scope of the first session, and the proof each step has to produce. **Nothing is
built until the last line of this document is approved**, and nothing merges to `main` without the error-path review.

## What already exists, found before proposing anything

- **Findings as code, with tests.** `server/src/diagnose/cabinet-findings.ts` (26 fixed checks), `network-findings.ts`,
  `network.ts`, `network-observations.ts`, `cabinet.ts`. Pure functions, no database, no regular expressions; a read that
  did not answer is "could not check", never healthy. A run is stored with the diagnoses for 30 days. Findings carry
  severity, certainty, evidence, the fix, a stable key and a priority, and link to the built-in issue type, the runbook,
  the known fixes and a fix button only where a safe catalog operation exists.
- **Alerts, rules and trends.** `server/src/services/alerts.ts`, `rules.ts`, `error-trends.ts` (with `error_daily`,
  `issue_daily` and `trend_state` in `0004_troubleshooting.sql`), `crashes.ts` and `/api/incidents/crashes` (rate
  limited, window bounded, one query per person), `site-outage.ts`, `baseline-drift.ts`, `usb-rules.ts`.
- **Path health, written and tested, connected to nothing.** `pathhealth-targets.ts`, `pathhealth-analysis.ts`,
  `pathhealth-correlation.ts`, `pathhealth-contracts.ts` with `server/test/pathhealth-analysis.test.ts` and
  `pathhealth-contracts.test.ts` green. There is **no table, no ingest route, no console page and no agent sampler**, so
  nothing feeds it samples. Its findings (loss during a window, ICMP filtered but the port answering, refused, clean
  path, "not measured" rather than healthy) are the sustained connection check the control-half plan's session 5 asks for.
- **Connectivity layering that already runs.** `network.test` (ping, dns, tcp; targets gateway, dns_server, sync_cabinet,
  platform_server; a count with loss and jitter; a sync target accepted only as a private IPv4 address on the cabinet's
  own connected network), `network.trace`, the sync-cabinet and platform-server checks in `network.ts`.
- **The operation catalog.** `contracts/schemas/operations/catalog.json`: 52 operations, 34 read and 18 write, each with
  a minimum role, a confirmation level and a schema validated before any other code touches the input.
- **Audit.** Append-only hash-chained log written by every service (`server/src/db/db.ts`), and step-up tokens bound to
  exact parameters (`app-control.ts`, `control-routes.ts`).
- **Migrations** `server/migrations/0001…0008`; the next number is `0009`.
- **Console** `pages/Triage.tsx`, `pages/alerts/*`, `pages/cabinet/*`, `pages/Fleet*.tsx`, `pages/admin/*`.
- **Tests** 81 server test files; the full suite is run as documented, `--test-concurrency=2 --test-timeout=600000`.

## The decisions (2026-10-25)

1. **Orchestration runs on the agent**: a signed, versioned module of catalog reads plus deterministic rules, run on a
   trigger, held in the bounded outbox, uploaded when connected. The server keeps the rules, the policy and every
   approval. Repairs always need the server, so **no offline repair**.
2. **A per-incident approval is a server record** naming the endpoint, the operation, the target and an expiry;
   executing it still needs that operation's own confirmation level.
3. **Device restart and disable/enable, DISM, SFC and scheduled-task changes may be added** to the catalog: Tier 2 with
   an authenticator code, device restart behind the protected-device list for the scanner class at first. Each still
   needs its own schema, tests and console button in its own phase.
4. **Windows Update keeps "never automatic uninstall"**; an uninstall stays manual and authenticator-confirmed.
5. **Tenant isolation stays as it is: one organization, one console, everything visible to the support roles.** No
   per-client access split; an Admin-controlled client filter is a convenience, not a boundary. Clients' data must still
   never travel inside another client's evidence package.
6. **Encryption at rest is disk-level encryption at the host**, plus passphrase-encrypted export bundles. SQL Server
   Express has no transparent data encryption, and Standard is not being bought for this.
7. **The login-free TDS pre-login is allowed**, against a target an Admin configured: no credential is ever stored or
   used, and it is never a connection to the cabinet application's database.

Still to confirm with phase 5, where they are built, keeping the defaults the audit recommends: parsing minidump headers
on the cabinet with nothing uploaded, authentication diagnostics from the System, Application, Netlogon, Kerberos and
Group Policy logs with no failed-logon counts, and out-of-band WinRE recovery as design only.

## The order

**The foundation (the first slice of phase 2, and the first session) → the first module on it: the SQL connectivity
ladder → then the rest of phases 2 to 6** as section 5 of the audit maps them (drivers and services; network and
application; controlled remediation; extended; intelligence). Each phase ends with passing tests, documentation and a
review before the next starts.

The phase numbering is the [roadmap's](../spec/13-roadmap.md), and **five phases are left (2, 3, 4, 5, 6)** — see
[remaining-phases.md](remaining-phases.md), which also maps these six engine phases into those five so nothing is counted
twice.

## The foundation in detail

1. **Module contract** (built 2026-10-29 as `contracts/schemas/diagnostics/module.schema.json`, with `server/src/diagnose/module.ts` and
   `server/test/diagnostic-module.test.ts`; nothing uses it yet). Planned as `contracts/schemas/diagnostic-module.schema.json`, its generated TypeScript beside the other
   contracts, and the types in `server/src/diagnose/module.ts`: applicability (roles, hardware, Windows
   versions as ranges; clients left out as built, see 09-open-decisions.md "Diagnostic modules and clients"), signals (which reads, which events, which thresholds), procedure (ordered checks, each a catalog
   read or a pure rule), evidence (what is kept and for how long), hypotheses with confidence, remediation (catalog
   operations only, with preconditions), verification (functional, or a read-back, and what "incomplete: no test exists"
   looks like), limits (what the module cannot tell) and escalation.
2. **The unified incident record** (built 2026-10-29 as `server/migrations/0017_incidents.sql` with `server/src/services/incidents.ts` and
   `server/test/incidents.test.ts`; since 2026-11-03 a diagnosis that finds a problem opens one, decision-log D16). Planned as `server/migrations/0009_incidents.sql`: one row joining symptom, evidence,
   hypothesis, proposed repair, approval, execution and verification, linked to its alerts, findings, commands and case
   notes, with an audit entry per step and retention by class. Audit section 7 names this as the thing that unifies
   "alert resolved" with "fleet operation verified".
3. **The capability registry, as data** (built 2026-10-29: `contracts/schemas/diagnostics/registry.schema.json`, the registry
   `contracts/diagnostics/registry.json`, `server/src/diagnose/registry.ts` and `server/test/capability-registry.test.ts`; supported
   hardware is the module's own applicability rather than a second copy in the registry). A JSON Schema plus a registry file above the operation catalog: capability
   (detect, diagnose, repair, verify), version, supported hardware, dependencies, the workflow chain and the phase.
4. **The existing findings re-expressed as modules, behaviour unchanged.** (Cabinet half built 2026-10-29: nine modules in
   `contracts/diagnostics/modules/cabinet-*.json`, registered as built; `cabinetFindings` runs their rule steps through
   `CABINET_RULES`; `server/test/cabinet-modules.test.ts` keeps reads, causes and repairs in step with the code. Network half
   built the same day: `contracts/diagnostics/modules/network-diagnosis.json`, run through `server/src/diagnose/network-module.ts`,
   kept in step by `server/test/network-module.test.ts`; the module contract now allows 48 causes and two-letter finding keys.) `cabinet-findings.ts` and
   `network-findings.ts` gain module wrappers; the regression proof is the same reads producing the same findings for the
   same input, with the existing tests unchanged and green.
5. **Tests alongside.** Schema validation including malformed and hostile input; the migration applied to a **copy of the
   live database** before it goes anywhere near the live platform; and the contract's refusal paths (an unknown read, a
   missing signal, a module claiming a repair it cannot verify).
6. **Console.** (Cabinet half built 2026-10-31: the History tab lists a cabinet's incidents and opens each to its steps and links, read
   through `GET /api/cabinets/:id/incidents` and `/api/cabinets/:id/incidents/:incidentId`, Tier 1 and up, read only. Triage's **Open incidents** view, built
   2026-11-03, lists every incident not yet closed across the fleet through `GET /api/incidents/open`, Tier 1 and up, read only, each
   opening on its cabinet's History tab. The crash incident page is built (D21): the `crash-incidents` module opens one incident per cabinet from its blue-screen and reboot-loop alerts, and the cabinet's crash page shows it, each alert once with its count.) The incident record appears where a person already looks — the cabinet's history and triage views and the
   crash incident page. No new page in this session.

## The first module: the SQL connectivity ladder

This is the "prove a server answers" work, and it is the first thing built on the contract so the contract is proven by
real content.

- **New:** one read operation `database.connectivity` (the name follows the catalog's `domain.verb` shape and is yours to
  change) with its schema in `contracts/schemas/operations/`, implemented in the agent's broker, that resolves the name,
  opens TCP, completes a TLS handshake (versions offered, certificate presented, chain result) and then sends a **TDS
  pre-login** packet to a target an Admin configured. Application-log client error codes supply the distinction between
  "authentication failed" and "the database is down" that a pre-login cannot make.
- **Reuses:** the DNS and TCP steps in `network.test`, the trace, the configured-target and private-IPv4 rules in
  `pathhealth-targets.ts`, the finding shape and the fix-button rule.
- **Never:** a credential, a login, or a connection to the cabinet application's database.
- **Testable here:** the TDS pre-login is .NET and cross-platform, so it is proven against the live SQL Server 2022 on
  the VPS before any cabinet sees it — the same "does a SQL Server answer" test, against a real server.

## Proof plan

- **A lab machine can show:** the contract and registry schema tests; the incident-record migration applied to a copy of
  live data and verified; the same findings for the same input after re-expression; the ladder's unit tests (a closed
  port, no listener, a port that speaks TLS but is not SQL Server, a real SQL Server, a wrong host), including the
  timeout and the "could not check" path; the console render; the full suite at the documented concurrency.
- **Only a real cabinet can accept:** the ladder against a real sync server on a real cabinet network, and the agent
  operation running on Windows in the broker. Until that run happens it is labelled "built and proven on Linux", exactly
  as the hardware and identity reads are today.

## What this session is not

No phase 2 (Plug and Play change events, device history, the functional-verification contract, device restart
operations). No remediation registry or per-incident approvals (phase 4). No privileged operation beyond the ladder's
read. No path-health wiring — that stays open as session 5 of the control-half plan. No console redesign. No merge to
`main` without the review.

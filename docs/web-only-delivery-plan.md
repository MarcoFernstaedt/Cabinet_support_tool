# Web Console delivery plan

Status: planning baseline at `9da51fc70d413440550cbf108b130045e477bb8e`, not production acceptance. The browser application is the **only Console** to deliver. Windows runs the cabinet Agent service, not an operator Console. ASP.NET Core Server and PostgreSQL remain the backend and fleet store. Historical WPF code is retained only until the corresponding web behavior and safety tests are replaced and accepted, then removed through a reviewed G08 cleanup. No WPF build, UI test or parity work is a product milestone. This decision supersedes older WPF fallback language in legacy documents. See the [current checkpoint and evidence tracker](build-tracker.md).

## Count and accounting

**26 tracked completion items: 18 web operator workflow acceptances (W01–W18) and 8 shared platform/release gates (G01–G08).** The workflow count maps exactly to register entries #4–#21. Register #1–#3 are historical WPF-first incident work, whose useful incident behavior is absorbed into W03 and W08; they are not three additional deliverables. A workflow marked source-merged or local-preview still counts as remaining until its applicable gates pass. This is a count of outcomes and shared gates, not a time estimate or 26 equally sized tickets. Each item can be split into reviewed implementation slices without inflating this baseline. No item below is accepted as of this baseline.

## Target architecture

1. Staff browser -> HTTPS ingress -> same-origin ASP.NET Core WebHost/BFF -> authorized Server API -> PostgreSQL. The browser receives a secure session cookie, never Agent credentials, access tokens or refresh tokens in JavaScript. Entra OIDC authenticates staff with verified tenant assurance; the Server resolves immutable staff identity, active role and cabinet/site scope for *every* read or write. A client-side control is not authority.
2. Windows Agent service -> outbound mutually authenticated or equivalently device-bound TLS registration, telemetry, polling and result delivery -> Server. Each device identity is bound to one cabinet; the Agent checks its own fixed action allowlist and safety preconditions. No inbound cabinet listener, remote desktop, arbitrary shell or application database access.
3. Server keeps action request/result identities, bounded typed projections, audit and unknown-outcome semantics separate from telemetry. The browser reads only approved projections; no generic action-output proxy, ZIP or arbitrary path. Machine observation, server receipt and operator view times remain distinct.
4. The current Node loopback preview and the Entra identity-only WebHost are separate implementations. G01 joins the *approved* web pages to an authorized same-origin BFF, not by exposing the current password gateway or by declaring the identity-only host ready. The existing WPF project is outside the delivery architecture.

## Shared gates, counted once

- **G01 | WebHost/BFF integration.** Replace loopback-only preview plumbing with a deployed same-origin Console, narrowly typed Server calls, server-held credentials, secure cookie lifecycle, CSRF on mutations and hardened HTTPS/proxy/CSP behavior. Connected navigation must never show demo records.
- **G02 | Real staff sign-in assurance.** Configure and exercise the organization's single-tenant Entra registration, enforced Conditional Access/authentication context and secure MFA (prefer phishing-resistant methods where supported). Verify actual sign-in, recovery and logout against the tenant; synthetic OIDC claims are insufficient. Production staff access stays off until verified.
- **G03 | Staff authority and revocation.** Map immutable IdP subject to active staff record, role and cabinet/site grants; deny cross-scope access at Server endpoints and BFF, enforce role/deactivation/revocation promptly, audit denials and changes, and test concurrent sessions and stale credentials. The current broad support-read policy is not sufficient by itself.
- **G04 | Diagnostic privacy and retention.** Approve field classification, jurisdiction, collection scope, display redaction, access logs, expiration and backup deletion for saved results and logs. Prove bounded projections and expiry, including action payloads not covered by telemetry cleanup. Do not ship log text before its fixed source and native safety are proven.
- **G05 | Native Windows and end-to-end Agent proof.** On authorized disposable Windows 10/11 machines, install the Agent service with intended identity and ACLs; exercise enrollment, device isolation, read-only collections, timeouts/child cleanup, restart/replay, Agent -> Server -> web result and failure states. HP interactive WER probing and single-file publish are not service-context acceptance.
- **G06 | PostgreSQL fleet and recovery.** Rehearse populated migration, concurrency, retention, backup/restore, credential revocation and representative fleet query plans/latency for finder, incidents, history, SMART and other bounded views. SQLite tests do not establish PostgreSQL behavior.
- **G07 | Browser and operator acceptance.** Exercise supported browsers, keyboard, screen reader, high contrast and narrow layouts across exact cabinet selection, stale navigation, denied, empty, partial, truncated and unknown states. Obtain operator sign-off for each workflow; preview JS tests do not establish accessibility.
- **G08 | Production security, operations and legacy retirement.** Review threats and dependencies, TLS/ingress, secrets, signing, shared persistent Data Protection keys, rate limits, audit, deployment monitoring, rollback and final-revision security review; record approved environments, release commit and written production approval. After every in-scope web replacement is accepted or its behavior explicitly retired, remove historical WPF source, tests, solution/build/CI and operator documentation in a reviewed cleanup, preserving relevant Agent/Server safety regressions. This includes enrollment/retirement and staff/session coverage, not just finder and incident pages. Do not delete those tests before their replacement is proved. No production claim from green CI alone.

## Operator workflows, counted once

Each W item requires its own reviewed UI/API/Agent slice where needed, automated denial/failure tests and applicable G gates. A saved-result page alone does not promise a fresh collection; if operators need to initiate a read, add an explicitly bounded request/queue flow to that workflow.

- **W01 (#4) Cabinet finder:** scoped stable pagination, site/client and freshness, missing/denied states.
- **W02 (#5) Cabinet detail:** exact cabinet identity, health timestamps, inactive/missing/stale navigation.
- **W03 (#6) Site incident queue:** scoped incidents and optional workload totals with evidence detail; absorb legacy #1–#3 queue/detail/annotation behavior without WPF parity.
- **W04 (#7) Event Viewer:** cabinet/action-pinned typed saved result, channel/provider/event detail, pending/partial/truncated states and native transport.
- **W05 (#8) Crash investigation:** independent bounded Event Viewer, WER and historical lifecycle clues; never infer crash cause or crash-time process presence. Verify native service-context WER/Security access and termination.
- **W06 (#9) Process/service diagnosis:** bounded process sample and separately retained service inventory; no controls or false PID joins.
- **W07 (#10) Fleet/site health:** global pagination, fresh vs stale vs unknown, standalone sites and fleet latency.
- **W08 (#11) Connectivity incident correlation:** existing peer-ICMP intervals and alerts are **historical only**, never a source for new scheduled cabinet-to-cabinet probes. The replacement requires separately timed read-only firewall configuration clues and network-quality evidence designed in a future slice; old failed ping did not prove firewall cause. Do not rename old ping counters as firewall evidence.
- **W09 (#12) Network history:** bounded cursor and receipt/observation times with uncertain gaps, not invented outage duration.
- **W10 (#13) Storage/SMART:** cabinet-bound trend, unknown legacy receipt/source provenance, Windows collection and representative queries.
- **W11 (#14) Restricted log explorer:** **blocked** pending fixed owned sink/source, reparse/ACL-safe native handles, privacy/redaction/retention approval and bounded typed ingestion; never use a ZIP or generic log proxy as substitute.
- **W12 (#15) Display diagnosis:** distinguish service-visible modes from uncollected interactive scaling/Magnifier/app zoom; any session-bound measurement needs separate consented least-privilege design and native proof. No remote control.
- **W13 (#16) Enrollment/retirement:** Supervisor review, audit, transactional decision and revocation; prove PostgreSQL concurrency, backup/restore and credential rotation before release.
- **W14 (#17) Staff/session administration:** scoped identity, roles, grants and revocation UI/records after G02–G03; no staff production access before those gates.
- **W15 (#18) Approved file staging/receipt:** **approval hold**; design signed, exact-target delivery and distinguish Server, Agent and verified local receipt. No execution implied or authorized by staging.
- **W16 (#19) Process lifecycle maintenance:** **approval hold**; creation-verified identity, explicit authority, impact preview, durable outcome and inert-device recovery. Shipping observation boundary stays enforced meanwhile.
- **W17 (#20) Network/display recovery:** **approval hold**; narrow changes, prior-state journal, independent access and timed revert; no automatic firewall repair.
- **W18 (#21) Approved update deployment:** **approval hold**; signed compatible packages, maintenance windows, interruption/reboot and rollback evidence, separate execution authority.

## Order and release policy

1. **Now:** preserve read-only action ceiling; implement G01–G03 and complete W01–W04 as the first real connected web vertical slice, with focused security/CI review at every merge. Staff use still waits for G02/G03 and relevant native proof.
2. **Then:** finish remaining read-only W05–W12 one at a time, addressing G04–G07 as their evidence paths require; do not turn blocked W11 into a fake success state.
3. **Then:** complete W13–W14 with reviewed identity and retirement safety. W15–W18 remain separate approval holds, not implied by permission to continue building the observational product. The final scope decision must either explicitly authorize and accept each or formally remove/rebaseline it; otherwise the full 18-workflow plan is not complete.
4. **Finally:** G08 and a consolidated final-commit release run. Record source merged, native verified, operator accepted and production approved as distinct states. Do not describe a synthetic preview, publish, or partial HP observation as a working production feature.

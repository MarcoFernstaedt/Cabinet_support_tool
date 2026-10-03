# Cabinet Support build tracker

**Checkpoint:** 2026-10-02 17:52 MST, after [PR #29](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pull/29), `main` `56d4e6306a73588938760c4d8dc235cc536defaa`. [Post-merge CI passed](https://github.com/MarcoFernstaedt/Cabinet_support_tool/actions/runs/37083262157) at that commit. **Product status: not finished, not deployed or accepted for staff use.** This is a checkpoint, not a live CI feed. Refresh the SHA, run links and status at every subsequent update.

**Where to read this:** open `docs/build-tracker.md` in the private GitHub repository, including GitHub Desktop's repository view or a browser. The [delivery plan](web-only-delivery-plan.md) specifies architecture, dependencies and acceptance criteria; the [workflow register](product-workflow-register.md) records source-level detail. This tracker is the single current checkpoint/status index. Keep all three in sync when scope changes.

## Definition and counts

- **26 tracked outcomes:** 18 active browser workflows W01–W18, mapped exactly to register #4–#21, and eight shared gates G01–G08. **Accepted: 0/26.** Some have merged local-preview source, not released behavior. A shared gate is counted once and can block many workflows. Count is not a time estimate.
- **Source status** describes what code exists: `preview source`, `partial preview`, `blocked`, `planned`. **Acceptance status** is separately `BLOCKED` until the listed evidence exists. `PASS` requires actual evidence linked to the exact revision and environment. A scope removal needs Marco's explicit decision and a new count; never silently tick a held item.
- Windows WPF Console delivery is canceled. Entries #1–#3 are *historical source*, not three extra active outcomes. Their incident behavior carries into W03/W08. Keep old WPF code only until equivalent web flows and relevant safety tests are accepted; then remove it under the G08 retirement checklist below. Deleting code now would discard useful regression coverage before replacement.
- Controlled changes W15–W18 are **approval holds**. Observational work and a checkpoint are not approval to upload files, execute installers, change firewall/network settings, terminate processes or deploy updates. No remote screen/control or automatic firewall repair.

## Current architecture and next seam

Staff browser -> same-origin ASP.NET Core WebHost/BFF -> authorized ASP.NET Core Server API -> PostgreSQL; Windows Agent service calls Server outbound using cabinet-bound credentials. The current Node browser preview is loopback-only, password-based and synthetic-data-only; the Entra WebHost has an identity boundary but **no cabinet data routes**. Do not call either a staff deployment. The next vertical slice is G01/G03 plus W01–W04: connect a scoped authorized BFF to finder -> exact cabinet -> incident/Event Viewer saved-result navigation, with denial and stale-scope tests. G02 real tenant MFA remains a staff-release prerequisite and can be configured separately without letting preview use real data.

## Workflow ledger

Each row gives present source, missing acceptance and the next evidence to capture. All are `BLOCKED` for release at this checkpoint. The linked register entry is the detailed requirement, not proof of acceptance. Complete and independently review one bounded slice at a time.

| ID | Outcome and source at checkpoint | Next evidence / blocker | Acceptance |
| --- | --- | --- | --- |
| W01 / #4 | Cabinet finder: local preview source | Authorized BFF, exact staff/cabinet scope, fleet pagination, accessible browser run | BLOCKED |
| W02 / #5 | Cabinet detail: local preview source | Exact ID, inactive/denied/stale navigation and real scoped freshness | BLOCKED |
| W03 / #6 | Site incident queue: local preview source; absorbs old #1–#3 | Authorized site pagination, historical evidence, optional count failure, PostgreSQL latency, browser QA | BLOCKED |
| W04 / #7 | Event Viewer: saved-result preview source | Actual service Agent -> Server -> web evidence, action-pinned detail, per-channel partial states, accessibility | BLOCKED |
| W05 / #8 | Crash clues: partial preview source; bounded WER and Security lifecycle source merged in #23/#24 | Native service-account WER/Security read and killable child, privacy/retention, accessible uncertainty presentation | BLOCKED |
| W06 / #9 | Process/service diagnostics: local preview source | Native service transport, current-vs-retained semantics, privacy, browser and staff-scope acceptance | BLOCKED |
| W07 / #10 | Fleet/site health: local preview source | Representative PostgreSQL plans, fresh vs stale vs unknown across pages, authorized browser run | BLOCKED |
| W08 / #11 | Connectivity incident correlation: local preview source; old #2 evidence carries here | Agent delivery, exact interval, site topology, coarse firewall clue only, privacy and browser QA | BLOCKED |
| W09 / #12 | Network history: local preview source | Native probe transport, retention/late-replay uncertainty, fleet cursor plans and browser QA | BLOCKED |
| W10 / #13 | Storage/SMART: partial preview; trend source merged #22 | Native Windows collection, receipt/provenance and key persistence, fleet queries and accessible web | BLOCKED |
| W11 / #14 | Restricted logs: no merged usable source | Bind Serilog sink to owned source; native ACL/reparse-safe reader, privacy/redaction/retention and bounded projection first | BLOCKED |
| W12 / #15 | Display diagnosis: partial preview; service-visible modes only | Native service/session proof; interactive scaling/Magnifier/zoom remain NotCollected pending consented least-privilege source | BLOCKED |
| W13 / #16 | Enrollment/retirement: partial preview and Office revocation source | Scoped Supervisor authorization, PostgreSQL overlap, backup/restore and key rotation, Windows/browser QA | BLOCKED |
| W14 / #17 | Staff/session administration: planned | G02/G03 first; scoped role/grant UI, deactivation and session revocation evidence | BLOCKED |
| W15 / #18 | Signed file staging/receipt: planned, approval hold | Explicit approval, exact-target signed staging, Server/Agent/local receipt proof; no execution authority | BLOCKED |
| W16 / #19 | Process lifecycle maintenance: planned, approval hold | Explicit approval, identity-bound inert process test, durable effect/unknown result/recovery | BLOCKED |
| W17 / #20 | Network/display recovery: planned, approval hold | Explicit approval, narrow prior-state journal, independent access and timed revert; no automatic firewall repair | BLOCKED |
| W18 / #21 | Update deployment: planned, approval hold | Explicit approval, signed compatible package, window/reboot/interruption/rollback proof | BLOCKED |

## Shared-gate ledger

| ID | Gate | Next evidence / blocker | Acceptance |
| --- | --- | --- | --- |
| G01 | Deployed same-origin WebHost/BFF | Join real web pages to typed Server projections; server-held authority, secure cookies, CSRF, HTTPS/proxy/CSP; no fictional connected data | BLOCKED |
| G02 | Real staff sign-in/MFA | Verify organization Entra tenant, Conditional Access/context, MFA sign-in, logout and recovery; synthetic OIDC tests are not proof | BLOCKED |
| G03 | Staff scope and revocation | Immutable IdP mapping; per-role and per-cabinet/site grants enforced on every Server route, denial/audit, deactivation and concurrent-session tests | BLOCKED |
| G04 | Diagnostic privacy and retention | Approve field classification, jurisdiction, access, action-result expiry, backup deletion; safe log source before any text | BLOCKED |
| G05 | Native Windows Agent/end-to-end | Authorized Windows 10/11 service-context installation, enrollment, read-only actions, timeout/restart, typed Server and browser readback | BLOCKED |
| G06 | PostgreSQL fleet and recovery | Populated migrations, plans/load, concurrency, retention, backup/restore and device revocation rehearsal | BLOCKED |
| G07 | Browser/operator acceptance | Supported browsers, keyboard/NVDA, high contrast, narrow layout and honest empty/denied/partial/stale states per workflow | BLOCKED |
| G08 | Production security, operations and legacy retirement | Threat/dependency review, TLS/secrets/signing/shared keys, deploy/rollback, final-commit review, written approval; after web acceptance retire WPF source/docs/CI safely | BLOCKED |

### G08 retirement checklist: remove historical WPF only after replacement

- [ ] Inventory all `CabinetPlatform.Console` and `Console.Core` source, tests, solution/project references, CI jobs, desktop kits, diagrams and operator docs. Map every remaining test to a current WebHost/Server/Agent safety invariant before deletion.
- [ ] Inventory every WPF/Core operator behavior, including enrollment/retirement and staff/session flows. Accept its in-scope web replacement (including W13/W14 where applicable) with real scoped Server paths and relevant G01–G07 evidence, or record Marco's explicit decision to retire that behavior. W01–W04 and W03/W08 incident coverage alone are insufficient. Keep historical maintenance safety regressions in Agent/Server tests rather than dropping them with WPF.
- [ ] In a separate reviewed PR, delete retired WPF executable/Core and WPF-only tests/assets, remove WPF from solution/build/CI/deployment/package instructions, and replace or archive stale operator docs/diagrams without making old broad staff policy authoritative.
- [ ] Prove the new deliverable matrix builds/tests on the final commit and contains no WPF release or deployment path. Verify CI readback and main merge. Record any intentionally retained compatibility code with owner, purpose and removal trigger, rather than calling the cleanup done.

This retirement work is a *subtask of G08*, not permission to erase code today or a 27th workflow. It can be split into smaller reviewed PRs. If WPF is still referenced after the claimed retirement, keep G08 `BLOCKED`.

## Completed source history and evidence boundary

- PRs [#2–#21](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pulls?q=is%3Apr+is%3Amerged) introduced the development-only web sign-in/navigation, bounded observational projections, incident, fleet and retirement slices. They were source milestones, not web/Windows production acceptance.
- [#22](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pull/22) SMART trends; [#23](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pull/23) bounded WER metadata; [#24](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pull/24) historical Security lifecycle clues; [#25](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pull/25) separated Agent Release/legacy test lanes; [#26](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pull/26) truthful uncollected display statuses; [#27](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pull/27) SQLite retirement attribution regression; [#28](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pull/28) single-file probe publish correction; [#29](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pull/29) web-only architecture/count. Those PRs are merged; no workflow became accepted by this list alone.
- HP lab `hp-edge`/`deviceb` was identified and an **interactive** bounded WER read returned MachineQueue `Unavailable`, MachineArchive `Partial`, zero allowlisted reports. No Agent service was installed there during the read. This is not a service-account or end-to-end acceptance and zero reports does not prove empty crash history.
- Checkpoint CI run `37083262157` passed Agent Release/legacy, selected Server and Console historical tests, WebHost tests, web tests and win-x64 single-file publish. It did **not** run a Windows service-context, representative PostgreSQL, Entra tenant, browser accessibility or physical-cabinet release matrix.

## Updating this tracker

For each implementation slice, add a dated entry in MST under **Change log** with: PR/commit, affected W/G IDs, exact source status, test commands/counts and CI link, independent review, native/browser/fleet evidence or BLOCKED reason, rollback and next narrow action. Update ledger row(s) and accepted count only when actual gate evidence exists. Check that 18 W and 8 G IDs remain unique, links resolve and the register/plan agree. Preserve old entries so a later source change cannot erase evidence or an unresolved gap. Never insert secrets, customer diagnostics or guessed PASS results.

### Change log

- **2026-10-02 MST, checkpoint** | PR [#29](https://github.com/MarcoFernstaedt/Cabinet_support_tool/pull/29), `main` `56d4e6306a73588938760c4d8dc235cc536defaa`; [post-merge CI success](https://github.com/MarcoFernstaedt/Cabinet_support_tool/actions/runs/37083262157). Architecture/count rebaseline only. W01–W18 and G01–G08 release acceptance all BLOCKED. No deployment or data change. Next: build G01/G03 + W01–W04 as a reviewed, scoped web vertical slice; G02 is required before staff use. Rollback: revert documentation checkpoint PR if scope changes, preserving this log and a replacement approved baseline.

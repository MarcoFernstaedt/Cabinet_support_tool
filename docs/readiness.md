# Release gates

Status: **production release blocked**. This document describes target acceptance, not a passing build report. The browser is the sole operator Console; Windows runs only the cabinet Agent service. Historical WPF builds and UI tests are not release gates. See the [26-item web-only delivery plan](web-only-delivery-plan.md) for 18 workflow acceptances plus eight shared gates, and the [workflow register](product-workflow-register.md) for source status. Earlier audit/test counts belong to their recorded revisions and are not final-commit evidence.

## Required evidence

1. Build the WebHost/BFF, Server, Agent and shared contracts from the final commit; run complete automated suites and record exit codes, failures and supported deployment targets. A source merge is not a deployed result.
2. Verify actual organization Entra registration and Conditional Access/MFA, immutable staff mapping, cabinet/site authorization and denial/revocation under concurrent sessions. Keep API/device credentials out of browser JavaScript. Exercise cookie lifetime, CSRF and logout.
3. Prove device-unique credential binding and that one cabinet cannot submit or consume another cabinet's work. Exercise Agent enrollment, service restart, key rotation and retirement/restore safety.
4. Complete real Windows 10/11 **service-context** Agent -> Server -> web journeys for each collected diagnostic, including stalled native APIs, child timeout/cleanup, partial/unavailable results, replay and interruption. An interactive HP probe, synthetic fixture and cross-publish are not substitutes.
5. Verify browser navigation, exact selected cabinet/action, stale scope, failure and unknown states, keyboard, screen reader, high contrast and narrow layouts with supported browsers and operator sign-off.
6. Rehearse populated PostgreSQL migrations, concurrency, retention, backup/restore and recovery on the intended version. Measure representative fleet query plans/latency and sustained Server/Agent resource use and outage behavior.
7. Approve diagnostic data classification, bounded display, retention/expiry, jurisdiction, audit and backup handling. Do not expose log content, unrestricted action output or diagnostic archives without an independently safe source and privacy review.
8. Review dependencies, secrets, installation ACLs, signing, transport certificates, ingress, persistent shared Data Protection keys, deployment monitoring and rollback. Obtain independent security/QA review of the final revision and written deployment approval.
9. If and only if separately authorized, exercise file-staging receipt and each controlled-change workflow against inert disposable Windows targets, with explicit authority, durable prior state, interrupted-operation recovery and unknown outcomes. Do not infer authorization to execute a staged file or automate firewall repair.

## Evidence rules

Record PASS, FAIL or BLOCKED per applicable workflow and shared gate with commit, environment, test command/output or operator artifact, reviewer and rollback owner. Missing Windows/service/browser/fleet evidence is BLOCKED, not PASS. Do not place secrets or real customer diagnostics in test evidence. A release record names an exact commit and approved scope. Approval to release a narrower read-only product must explicitly rebaseline and remove held workflows; it cannot silently mark them complete.

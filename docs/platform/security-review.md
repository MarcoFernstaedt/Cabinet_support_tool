# Security review, October 2026

A red-team review of the agent, installer, deployment, server, console, contracts and supply chain. The threat model is in [threat-model.md](threat-model.md). Status:

- **Fixed**: changed and covered by a test.
- **Partly fixed**: the main path is closed; what remains is listed.
- **Open**: not yet changed; the reason is given.
- **Accepted**: a known limit, documented.

## Agent, installer and deployment

| # | Severity | Finding | Status |
|---|---|---|---|
| A1 | High | A service's display name bypassed the refused-services list (for example stopping the agent's own broker). | Fixed. Names are resolved to the key name first; a display name is refused. `ServiceDisplayNameTests`. |
| A2 | High | The broker did not enforce read-only mode or the write limit, so a compromised network process could make any write. | Fixed. The broker reads the admin-only config and keeps its own persisted write counter. `BrokerOwnChecksTests`. |
| A3 | High | The trusted driver publisher (Microsoft's WHQL signer) covers every signed driver, including vulnerable ones. | Partly fixed. A driver class allow-list is checked on upload and on the cabinet; a second Admin must approve each package. Remaining: an allow-list of approved catalog hashes. |
| A4 | Medium-High | Installer: user-writable source folder, no Authenticode check, CA file replaceable, token file left behind. | Fixed. ACL check, Authenticode on every binary (`-AllowUnsigned` for development builds), `-PlatformCaSha256`, token deleted after use. |
| A5 | Medium | Driver zips were unpacked before the signature check; no free-space check. | Fixed. INF and catalog are checked in memory first; free space must be at least four times the size plus 2 GB. `DriverClassTests`. |
| A6 | Medium | Event floods: any program can write Application errors. | Partly fixed. 20 per source per look, then a summary event. `EventFloodTests`. Remaining: the queue file is rewritten on every enqueue (performance, not safety). |
| A7 | Medium | The console was exposed to the whole internet. | Fixed. Caddy `CONSOLE_ALLOW_FROM` address allow-list and HSTS. |
| A8 | Low-Medium | Release builds without signing keys are unsigned. | Accepted. The installer refuses them without `-AllowUnsigned`. |
| A9 | Low | Two upgrade requests could race on the staging folder. | Fixed. A lock. |
| A10 | Low | The cabinet key is not in the TPM. | Open. Needs testing on the cabinet hardware. |

## Server

| # | Severity | Finding | Status |
|---|---|---|---|
| S1 | Medium-High | The fleet crash incident query had no bound: one person could load months of every cabinet's events into memory. | Fixed. 14-day window, aggregated in SQL (one row per distinct change per cabinet), one query per person at a time, 15 s statement timeout. `crashes.test`. |
| S2 | Medium | Network diagnoses had no concurrency limit. | Fixed. A running diagnosis on the same cabinet is shared; at most 3 running per person. `demo.test`. |
| S3 | Medium | Changing your password ignored lockout and per-address limits. | Fixed. Same limits as sign-in; failures are audited. |
| S4 | Medium | Step-up tokens for admin actions were bound to the action and target but not the parameters. | Fixed. Every confirmed body is bound to its canonical hash: accounts, settings, clients and sites, issue types, suppressions, firewall policies, scanner and sync settings, enrollment approval, rules, packages, releases, rollouts, write pauses, demo mode. `console-api.test` checks a token confirmed for one body is refused for another. |
| S5 | Low-Medium | A real cabinet could be enrolled into a demo client, and turning demo mode off would delete it. | Fixed. Enrollment and site creation refuse demo clients; turning demo mode off refuses if a real cabinet is under one. `demo.test`. |
| S6 | Low | Demo mode on, off and reset needed only a click. | Fixed. An authenticator code bound to the change. |
| S7 | Low | The cabinet timeline kept the oldest 2,000 events, hiding the newest. | Fixed. It keeps the newest 2,000. |
| S8 | Low | The same authenticator code could pass twice in a race. | Fixed. The code's time step is claimed with a conditional update. |
| S9 | Low | Reads of cabinet data are not audited one by one. | Accepted. Presence and activity show who had a cabinet open. |
| S10 | Low | The enrollment rate-limit map had no bound; the certificate request was checked before the token. | Fixed. Pruned past 10,000 addresses; the token is checked first and is not used up by a bad request. `agent-api.test`. |
| S11 | Info | "Account locked" (429) versus "wrong password" (401) tells an attacker an account exists once locked; a failed diagnosis showed raw error text; no per-person limit on live-update connections. | Partly fixed. Diagnosis errors are now generic. The locked message stays so staff know why they cannot sign in. |

## Console, contracts and supply chain

| # | Severity | Finding | Status |
|---|---|---|---|
| C1 | Medium | The agent zip is unsigned and its hash comes from the same channel. | Partly fixed. The installer checks Authenticode; the CA hash is checked. Signing the zip needs a code-signing certificate. |
| C2 | Medium | The Dockerfile's publish step ignores the NuGet lock files. | Open. Needs `RuntimeIdentifiers` in the projects and locked restore. |
| C3 | Low-Medium | No HSTS. | Fixed in Caddy. |
| C4 | Low | CI had no permissions block; actions are pinned by tag. | Partly fixed. `contents: read`; pinning by SHA is open. |
| C5 | Low | Images are pinned by tag, not digest. | Open. |
| C6 | Low | The session cookie lacks the `__Host-` prefix. | Open. Renaming signs everyone out once; planned with the next deployment. |
| C7 | Info | Bootstrap tokens last 7 days. | Accepted. Single use, and each enrollment still needs an Admin's approval. |
| C8 | Info | Tier 2 may change or delete any Windows firewall rule by exact name. | Answered by the owner (October 2026): yes, kept audited and bounded by the safety net (09-open-decisions.md, "Decisions, October 2026 (owner)"). The separate question of the *confirmation level* for a rule change is still open there. |

Clean in the review: no XSS sinks, CSRF protection (Origin check and SameSite), strict CSP, path traversal in static files, cookie redaction in logs, bounded contracts with `additionalProperties: false`, program allow-list by full path, npm and NuGet audits.

## Automated security tests

Hostile and malformed input is tested on every route and every contract (`contracts` 477 tests), plus the tests named above. Tests run on Linux; the Windows-only code (service key names, broker config, installer) is covered by unit tests with fakes and by the Windows CI job, which is not running while GitHub Actions minutes are unavailable.

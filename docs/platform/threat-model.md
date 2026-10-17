# Threat model

A STRIDE review of the Mashura cabinet diagnostics platform, October 2026. It covers the agent (network service and broker), the agent API, the console API and console, the database, the deployment on the VPS, and demo mode. The rules it checks against are in [docs/spec/02-security-model.md](../spec/02-security-model.md) and [CLAUDE.md](../../CLAUDE.md). Findings and their status are in [security-review.md](security-review.md).

## What we protect

| Asset | Why it matters |
|---|---|
| Cabinets (Windows PCs that dispense medication) | A compromised cabinet can stop a pharmacy or vet clinic working. The platform must never become a way in. |
| The fleet as a whole | One stolen account or one bug must not reach every cabinet at once. |
| Cabinet data (events, results, crash evidence) | Operational, not patient data; still confidential to each client. |
| Accounts, sessions, authenticator secrets | The way to change anything. |
| The audit log | Who did what; must be tamper-evident. |
| Release and package signing keys | Kept off the server and out of the repository. |

## Trust boundaries

```
 Support staff browser ──HTTPS (console, Caddy, IP allow-list)──▶ Console API ──┐
                                                                                ├──▶ SQL Server (app role, least privilege)
 Cabinet: agent network service ──mutual TLS, outbound only──▶ Agent API ───────┘
     │  (low privilege, no admin rights)
     └── named pipe, ACL to the service SID ──▶ Broker (SYSTEM, never opens a network connection)
                                                  └── fixed programs by full path: netsh, pnputil, msiexec, sc …
```

1. **Browser ↔ console API.** Untrusted input. Session cookie (HttpOnly, SameSite=Strict), Origin check, strict CSP, every body checked against its JSON Schema, every role check on the server.
2. **Cabinet ↔ agent API.** Mutual TLS with a per-cabinet certificate from the platform's own CA. A cabinet can only speak for itself. Enrollment is the only unauthenticated path; it needs a single-use bootstrap token and an Admin's approval.
3. **Network service ↔ broker.** The network service is assumed compromisable (it parses server messages). The broker re-validates every request, enforces read-only mode and its own write limit, and refuses everything outside the fixed catalog.
4. **Server ↔ database.** The app role cannot delete the audit log, security alerts or rollout history.
5. **Real ↔ simulated data.** Demo cabinets live in demo clients, are tagged, never receive real commands and never answer for real cabinets.

## STRIDE

| Threat | Where | Controls |
|---|---|---|
| **Spoofing** a support person | Console sign-in | Argon2 passwords, an authenticator for every account, lockout after 5 failures, per-address limits on sign-in, codes and password confirmation, sessions with idle and absolute timeouts. |
| Spoofing a cabinet | Agent API | Mutual TLS; certificate bound to the cabinet; enrollment only with a single-use token plus Admin approval; the token is checked before any certificate request is parsed. |
| Spoofing the server to a cabinet | Agent | The agent pins the platform CA; the installer checks the CA file's SHA-256. |
| **Tampering** with a command in flight | Server → cabinet | TLS; commands are typed, schema-checked on both ends, single-use (replay protection) and expire. |
| Tampering with what a confirmation approved | Console | Step-up tokens are bound to the action, target and exact parameters (their canonical hash); a token confirmed for one change is refused for any other. |
| Tampering with software sent to cabinets | Packages, upgrades | Signed by a trusted publisher, hash-checked on the cabinet, driver class allow-list, approved by a second Admin; agent upgrades signed with an offline key, rollback on failure. |
| Tampering with the audit log | Database | Hash chain, daily verification, app role has no DELETE. |
| **Repudiation** | Everywhere | Every change, refusal, sign-in and step-up is audited with the person, target and source address. |
| **Information disclosure** | Console | No Security-log reads; secrets in environment only; error codes, not stack traces; failed diagnoses show a generic message. |
| Information disclosure across clients | Console | Not isolated: every signed-in person sees every client (see "Tenant isolation"). |
| **Denial of service** against the server | Console API | Body limit 256 KB; crash incident window 14 days, one query per person at a time, 15 s statement timeout, aggregated in SQL; network diagnoses shared per cabinet, at most 3 running per person; bounded in-memory rate-limit maps. |
| Denial of service against a cabinet | Agent | Operation rate limits on the agent and in the broker; event flood cap per source with a summary event; free-space check before package install. |
| Denial of service against the fleet | Bulk changes | Password confirmation, 200-cabinet limit, fleet and client write pause, per-person write limit with a security alert. |
| **Elevation of privilege** on a cabinet | Network service → broker | The broker is the only privileged code; no shell, eval or script runner; programs started by full path with argument arrays; refused services resolved by key name (display names no longer bypass the list). |
| Elevation inside the console | Roles | Tier 1, Tier 2, Admin checked on the server and again on the agent; nobody changes their own role; the last Admin cannot be removed. |

## Tenant isolation

Not implemented, by design: Mashura's support team supports every client, so every signed-in person sees every client. If clients or third parties are ever given accounts, the platform would need a client scope on each account, enforced in every query (cabinets, events, alerts, commands, incidents, diagnoses, audit), plus tests that one client's account cannot read or change another's. This is recorded in [09-open-decisions.md](../spec/09-open-decisions.md).

## Demo isolation

- Simulated cabinets exist only in demo clients; enrollment and site creation refuse demo clients, so a real cabinet cannot be filed under one.
- Turning demo mode off deletes only simulated records, and refuses if a real cabinet is found under a demo client.
- The simulator never answers commands for a real cabinet; rollouts exclude simulated cabinets.
- Turning demo mode on, off or resetting it needs an authenticator code bound to the change.

## Accepted risks

- Release builds made without signing keys are unsigned; the installer refuses them unless `-AllowUnsigned`.
- The cabinet's private key is in the Windows software key store, not the TPM.
- Reads of cabinet data are not individually audited; presence shows who has a cabinet open.

# Emergency offline access (milestone 14)

A local console on the cabinet, **Cabinet Support Diagnostics**, that works when the cabinet cannot reach the platform server, and that stays locked until a support technician grants a short, device-specific, single-use authorization. This is the design to build in milestone 14; the decisions it needs are in [09-open-decisions.md](09-open-decisions.md) under "Emergency offline access".

It follows every rule in [02-security-model.md](02-security-model.md) and [CLAUDE.md](../../CLAUDE.md): no shell, no new way to run arbitrary programs, operations only from the fixed catalog, privileged work only in the broker, every input checked against its contract.

## What already exists and is reused

| Need | Existing piece |
|---|---|
| Device identity | The cabinet's enrollment ID and its key in the Windows key store (`ServerConnection.cs`) |
| Diagnostics and fixes | The operation catalog, `CommandValidator`, `OperationRegistry` and the broker; nothing new runs commands |
| Privilege separation | Network service (low privilege, virtual account) and broker (SYSTEM, no network), joined by a locked pipe |
| Signatures | ECDSA P-256 with SHA-256, already used for signed agent upgrades (`ecdsa-p256-sha256`), from the .NET and Node standard libraries |
| Local buffering | The agent's event queue (5,000 events) |
| Central identity, roles, step-up codes, audit log, security alerts | The console API |
| Network findings | The rules in `server/src/diagnose/network-findings.ts` |

## Parts

1. **The desktop app.** A small Windows app, installed with a desktop shortcut "Cabinet Support Diagnostics". It runs as the signed-in user with no administrator rights and contains no diagnostic code: it only shows screens and talks to the agent's network service over a new local pipe. Keyboard navigation and screen readers throughout.
2. **The local pipe.** Open to interactive users, but it accepts only a fixed set of requests, each checked against a contract in `contracts/schemas/local/`: status, new challenge, redeem, run (only inside an open session, only operations the session allows), end session, export report. Calling it directly without a valid session gives nothing more than the locked screen does.
3. **Online versus offline.** The cabinet counts as offline only when it has had no successful contact with the server for 5 minutes. Online, the local console stays locked and says to call support: technicians work from the central console as today, with its sign-in, roles and audit. Emergency codes are refused while online.
4. **Challenge.** The agent creates a challenge: a random 80-bit request code (shown as `XXXX-XXXX-XXXX-XXXX`), the requested level, and a challenge ID. One challenge is open at a time; it lives in the agent's memory and protected state, and expires 30 minutes after it was created, measured on the agent's monotonic clock (changing the Windows clock does not extend it). A restart of the agent discards it.
5. **Authorization.** In the central console, on the cabinet's page, Emergency access: the technician enters the request code, confirms the client, site and cabinet, picks the level and the session length, and confirms with their authenticator code. The server signs `{credentialId, cabinetId, requestCode, level, maxSessionMinutes, issuedAt, notAfter, technician}` with a dedicated emergency signing key (never the CA key), records the issue in the audit log and in an `emergency_credentials` table, and shows the credential.
6. **Verification on the cabinet, without the network.** The agent checks the signature against public keys installed by the installer (admin-only file; a list, so keys can be rotated), then the cabinet ID, the request code, the challenge's age, the level against the policy compiled into the agent, and that the credential ID was never redeemed. Any failure is refused and logged.
7. **Single-use redemption.** The challenge is marked redeemed and the credential ID added to the redeemed list in the service's protected state file before the session opens (write, flush, then open). A redeemed challenge or credential is refused for ever after, including after reconnection.
8. **The session.** One bounded session: Level 1 and 2 up to 60 minutes, Level 3 up to 30, measured on the monotonic clock. It ends at its time, when the customer or technician ends it, when the agent restarts, or when the cabinet reconnects to the server. A new session needs a new challenge.
9. **Levels.** Each level is a fixed list of catalog operations compiled into the agent:
   - Level 1, read-only: `system.info`, `network.config`, `network.test`, `firewall.state`, `services.list`, `devices.list`, `drivers.list`, `disk.smart`, `time.status`, `peripheral.status`, and `eventlog.query` on the System and networking logs.
   - Level 2, advanced: Level 1 plus `eventlog.get`, all allowed logs, and the local evidence export.
   - Level 3, remediation: Level 2 plus `service.control` (watched services only), `firewall.applyPolicy`, `time.setZone` (the site's cached zone only) and `time.sync`. Renewing a DHCP lease and restarting an approved application need new catalog operations first (decision in 09).
   Level 3 is never implied by Level 1 or 2; it needs a Tier 2 technician.
10. **The network playbook.** After unlocking, "Run diagnostics" runs the network checks with Level 1 operations and compares them with the site configuration the agent cached from its last heartbeat (sync address and ports, expected zone, firewall policy). Results are Passed, Failed, Warning or Unable to determine, in plain language, never claiming a root cause without the evidence for it. The findings rules are ported from the server's, with the same tests run against both.
11. **Local evidence.** Each session writes a report (results, times, agent version, failures, which credential and level, never the credential itself) to the service's folder, capped at 20 MB. "Export report" writes it to removable media encrypted to the server's public key (ECDH P-256 and AES-GCM from the standard library), so only the platform can read it.
12. **Local security log.** Invalid, expired and reused credentials, successes, session start and end, every operation run: written as a hash chain (each record carries the hash of the one before) in the protected folder, capped at 5 MB, and queued for the server.
13. **Abuse limits.** 5 wrong credentials end a challenge; each new challenge waits longer (1, 2, 4 ... up to 15 minutes); at most 10 challenges an hour. Never a permanent lockout.
14. **Reconnection.** When the server is reachable again the agent ends any emergency session, uploads the security log and session reports, and reports every redeemed credential. The server checks the chain, matches redeemed credentials against those it issued (one it never issued, or a credential redeemed twice, is a security alert), voids any issued credential that was not redeemed, and raises "Emergency Offline Diagnostic Access Used" with cabinet, client, site, technician, times, level, operations and anything suspicious. The agent marks the records as reconciled only when the server confirms.

## Limits to state plainly

- A local Windows administrator controls the machine: they can stop the agent, read or delete its files, or replace its binaries. Nothing on the cabinet is immune to that; the hash chain shows that records were changed or removed only once the cabinet reconnects.
- Restoring a disk image could bring back an old, not yet redeemed challenge. It still expires 30 minutes after it was created and ends with an agent restart, and reconciliation reports any credential redeemed twice.
- The Windows clock can be wrong or changed. Challenge and session limits use the monotonic clock; the credential's own `notAfter` is checked too, so a wrong clock can only shorten access, never extend it.

## Tests to write with it

Forged and altered credentials, another cabinet's credential, a reused challenge or credential, expired challenges, a level higher than granted, a Level 3 operation in a Level 1 session, calling the pipe directly without a session, brute force and the delays, clock changed forward and back, corrupted or missing state (fail closed), an agent restart mid-session, reconnection during a session, a failed upload retried, session expiry, and an altered security log detected at reconciliation.

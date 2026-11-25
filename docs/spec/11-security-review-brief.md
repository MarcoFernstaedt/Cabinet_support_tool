# Security Review Brief

For the head of development. This summarizes what the cabinet diagnostics platform can do to a cabinet, how each risk is controlled, what risk remains, and the gates before it reaches the fleet. The detail behind every point is in 02-security-model.md and the component specs.

## What we are asking for

Approval to build and test on office cabinets now, and to move through each rollout stage only when its gates are met. Nothing reaches a client cabinet before an independent security test and your sign-off.

## What the platform can do on a cabinet

Read, available to all support tiers:

- System details, devices and drivers, fingerprint scanner status, Windows update status, drive health
- Hardware, driver, storage, network, firewall and update event logs, with full detail of any entry
- Network and firewall configuration
- File and folder names on the C drive, without opening files
- Connectivity tests to the gateway, DNS servers, the site's sync cabinet and the platform server only

Change, Tier 2 and Admin only, each with a fresh authenticator code, one cabinet at a time:

- One adapter's IP settings or DNS servers
- One firewall profile on or off, with an automatic switch back on after a time limit
- One firewall rule created, changed, enabled, disabled or deleted, or a saved firewall snapshot restored
- Install one signed driver package or signed MSI installer from an approved library
- Remove one third-party driver

## What the released platform cannot do

- Run commands, scripts, EXE files or anything outside its fixed list
- Copy arbitrary files onto a cabinet
- Read the CUBEX application, its database, or the Windows Security log
- Take remote control or view the screen
- Change many cabinets in one action
- Accept connections into the agent. The [development SSH transport](02-security-model.md#development-ssh-transport) dials the existing cabinet SSH service over loopback.

## How one change reaches a cabinet

1. A Tier 2 user signed in with password and authenticator code, on the internal network or VPN, chooses the change. Two-factor is mandatory for every account that can make changes.
2. They confirm it with a fresh authenticator code, bound to that single action.
3. The server checks their role, the fleet write pause, and their hourly write limit, then writes the audit entry.
4. The agent collects the command over mutual TLS and checks it is a known operation, for this cabinet, unexpired, never seen before, with valid parameters, not blocked by read-only mode, and within the cabinet's own write limit.
5. The agent's privileged broker, which never touches the network, checks the request again and carries it out.
6. For packages, the agent verifies the hash, the signature and that the signer is on its own trusted list before anything is installed.
7. For network and firewall changes, the agent reverts on its own if it cannot reach the server within 2 minutes.

## Worst cases and what limits them

Stolen support account:

- Any account that can make changes needs the authenticator as well as the password. Every account works only from inside the network or VPN.
- A read-only Tier 1 account needs the authenticator too when two-factor is on for it, and an admin setting can require that for everyone.
- Every write needs another fresh code, is limited per hour, and touches one cabinet.
- Unusual activity raises a security alert, and an Admin can pause all writes at once.

Compromised server:

- Released agents execute only the fixed catalog. The [dev-only SSH transport](02-security-model.md#development-ssh-transport) is governed by the cabinet’s OpenSSH policy.
- Cannot install anything unsigned or from an untrusted signer; the agent checks itself.
- Cannot push agent updates; those need a signature from a key the server never holds.
- Can still read diagnostics and issue approved changes within each cabinet's own limits. This is the main remaining risk and is why the server sits behind the strongest hosting controls.

Compromised or careless Admin:

- New software needs a second Admin's approval.
- Every action needs a fresh authenticator code and lands in a tamper-evident audit log.
- Suppressing alerts needs a reason and expires.

Impostor cabinet:

- Cannot connect without a certificate, and gets one only after an Admin approves it by matching serial number, site and install time.

Interception or replay:

- Mutual TLS throughout; every command expires within minutes and cannot be reused.

Malicious agent update:

- Rejected unless signed by the offline release key (D143), version-checked, and released in stages starting with one cabinet.

Honest mistake:

- Network and firewall changes revert if the cabinet loses contact, firewall profiles come back on by themselves, and every firewall change can be restored from a snapshot.

## Remaining risks we accept knowingly

- A compromised server can read diagnostic data fleet-wide and make approved changes within limits.
- A trusted vendor whose own signing key is stolen could produce a driver the agent accepts. The trusted list is kept short.
- Admins are trusted; controls make abuse visible and slower, not impossible.
- The agent's broker runs with administrator rights, as any tool that installs drivers must.

## Data

The platform collects no patient data. It reads Windows system information only: event logs, devices, drivers, network and firewall settings, and file names. It never reads the CUBEX application or its database. The data is still confidential to each client, so only what is needed is collected, every view is logged, and data is encrypted in transit and at rest.

## Rollout gates

1. One office cabinet: core build complete and tested.
2. All in-office cabinets: a clean week on one cabinet.
3. Client beta: independent security test passed with serious findings fixed, incident response steps written and rehearsed, database restore tested, your sign-off, client agreement in place.
4. Wider fleet, in stages: a clean beta for an agreed period.

## If something goes wrong

- Pause all writes fleet-wide or for one client, instantly.
- Revoke any cabinet's certificate, cutting it off immediately.
- Disable any user, ending their sessions immediately.
- Pause an agent upgrade rollout, or release a signed rollback.
- Use the audit log to see exactly who did what, where and when.

## How it is built

- Memory-safe languages throughout: C# on the agent, TypeScript on the server and console.
- Every input validated against a shared schema before use.
- Protected main branch, with two reviewers on agent, broker, protocol and authentication changes.
- Pinned, scanned dependencies and a bill of materials for every release.
- Releases built and signed only by the pipeline.

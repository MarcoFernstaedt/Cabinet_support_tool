# Security Model

## Threat model in one paragraph

The agent can change things on client machines, so the whole system is a potential remote code execution channel into 8,000 cabinets in healthcare settings. The main threats are: an attacker taking over the server, an attacker stealing a staff account, a careless or malicious insider, an impostor machine joining the fleet, someone intercepting or replaying commands, a malicious package or agent update, and an honest mistake that cuts a cabinet off. Each control below answers one or more of these.

## Control 1: fixed operation catalog

- The agent accepts only operations named in its catalog (04-agent-spec.md). Unknown operation names are rejected and reported.
- Each operation has a strict parameter schema. Anything that fails validation is rejected before execution.
- The catalog is compiled into the agent. The server cannot add operations; only a signed agent upgrade can.
- Write operations use narrow, typed interfaces: one adapter, one rule, one profile, one package, one cabinet at a time.
- There is no shell, no script runner, no general file transfer and no way to run an arbitrary file.

## Control 2: privilege separation on the cabinet

- The agent's network process, which handles every byte from the server, runs without administrator rights.
- A separate broker process holds the administrator rights, never touches the network, accepts only typed requests from the network process over a locked-down local pipe, and validates them again.
- A parsing bug therefore cannot directly become full control of the cabinet.

## Control 3: encrypted, authenticated channel

- All console traffic uses HTTPS. No plain HTTP listener exists.
- All agent traffic uses mutual TLS. The agent verifies the server against a pinned certificate authority, and the server verifies the agent's own certificate.
- The agent API listens on a separate port and hostname from the console API, so a flaw in one does not expose the other.
- The console is reachable only from Mashura's internal network or VPN. Only the agent API faces the internet.
- Cabinets open no inbound ports; the agent only connects outward to one hostname.
- TLS 1.2 minimum, TLS 1.3 preferred.

## Control 4: agent identity and enrollment

- A new agent generates its own key pair. The private key never leaves the cabinet and is stored with Windows machine-level key protection, marked non-exportable.
- The agent sends a certificate signing request with a one-time, short-lived bootstrap token and its machine fingerprints: hostname, machine serial number, MAC addresses, provisioned client and site if known, and the time it came online.
- **A site installer** (finding F6.R1, decision-log D35) carries one token several cabinets of one site can use: an Admin makes it for that site, optionally one role, and a number of cabinets (1 to 100, default 10) for a number of days (1 to 30, default 7), confirmed with an authenticator code bound to exactly those. It stops at either limit and can be revoked early (`token.revoke`, also confirmed); each use is counted under a row lock and audited with the token. A request made with it is approved only at that site, and with that role when one was named (`not_this_site`, `not_this_role`). A token with no site is for one cabinet, once, as always. The database holds the limits too: a token for more than one cabinet must name a site, and never more than 100.
- The request waits in the pending queue. No certificate is issued until an admin approves it.
- The admin matches the fingerprints against the install that just happened. The serial number checked against the provisioning record is the strongest single check. A request matching no recent install is rejected.
- Fingerprints can be spoofed by someone who knows them, so they inform the admin's judgment rather than replace it.
- Agent certificates last 90 days and renew automatically using the current certificate.
- Removing a cabinet revokes its certificate. The server checks every connecting certificate's serial against the cabinet record, so a revoked agent is refused immediately.
- The key that signs agent certificates lives in the KMS, not on the server disk.

## Control 5: replay protection

- Every command has a unique ID, an issue time and an expiry. Read commands expire after 5 minutes, write commands after 2 minutes.
- The agent rejects expired commands and any command ID it has already seen within the expiry window plus clock-skew tolerance.

## Control 6: staff authentication

- Passwords hashed with Argon2id. Login rate-limited per account and per address, with temporary lockout after repeated failures.
- Two-factor authentication uses an authenticator app and is turned on per account. When it is on, login asks for the password and then the authenticator code.
- Every account, of every role, must have two-factor on (changed in milestone 9, 12-milestones-8-to-12.md). Accounts set it up at first login and cannot turn it off themselves.
- Sessions stored on the server. The cookie is HttpOnly, Secure, SameSite Strict, and holds only a random session ID.
- Sessions expire after an idle period and an absolute maximum.
- State-changing requests also require a matching Origin header.
- Resetting a password or authenticator, or disabling an account, ends all of that user's sessions immediately.
- The last remaining Admin cannot be deleted or demoted.

## Control 7: role-based access

- Tier 1: read operations, event logs and alerts, plus firewall profile changes and applying the client firewall policy (milestone 9)
- Tier 2: everything Tier 1 can do, plus every other write operation, the watched-services list and proposing symptom rules and runbooks
- Admin: everything Tier 2 can do, plus user administration, cabinet approval, client and site management, the software library, approving symptom rules, suppressions, fleet safety controls, settings, audit review and agent upgrades
- Roles are checked on the server for every request. The console hiding a button is convenience, not security.

## Control 8: step-up authentication

- Viewing is frictionless. There is no per-site or per-cabinet password.
- Since milestone 9, confirmation is matched to risk (12-milestones-8-to-12.md "Confirmation levels"): quick, self-healing single-cabinet fixes need a confirmation click; rare or stranding single-cabinet writes, every rule change and every admin action need a fresh authenticator code; any change to more than one cabinet needs the person's password again.
- A successful step-up produces a token bound to that one action, its target and the exact parameters, valid for 2 minutes. It cannot be reused.
- **The operator command line.** Access to the server's shell is not authority. Every `platform-admin` command that changes something takes
  `--as <username> --code <6 digits>`: the code from that person's own authenticator, checked as a step-up is. A code is used once (its
  step is claimed atomically, shared with the console), a locked account is refused, a missing or malformed code is refused before any check, and a wrong or reused
  code counts toward the same lock as the console's step-up failures (five lock the account for 15 minutes and raise a security alert). Every attempt it checks a code for, passed or refused, is audited as `cli.authenticate` with `via: "cli"` and
  `proof: "authenticator"`; an attempt refused before that (no `--as`, a missing or malformed code, an unknown name, a role below the command's, no
  authenticator set up, an account still locked) is refused with nothing on the audit chain. Commands that only read take no `--as`.
  The one exception is the first Admin: `user add` runs without `--as` only while no active Admin exists (the install), and that row is
  audited with `bootstrap: true`; afterwards creating a user needs an Admin's code like any other change.

## Control 9: approved software library

- Files reach a cabinet only as approved packages: signed driver packages or signed MSI installers. No EXE installers, scripts or general file transfer.
- Two-person rule: one Admin uploads, a different Admin approves.
- The server checks hash, signature and signer on upload. The agent checks all three again before installing, against a trusted publisher list that only a signed agent upgrade can change.
- Even a fully compromised server cannot get an unsigned file, or a file signed by an unlisted publisher, installed on a cabinet.

## Control 10: limits on damage

- Write pause: Admins can stop all writes fleet-wide or per client at once.
- Per-user write limit on the server, default 20 per hour, and a separate per-cabinet write limit enforced by the agent itself.
- One bulk write only: applying a client's own firewall policy to its cabinets that differ from it, with password confirmation, at most 200 cabinets at a time, within the write pause (milestone 9). Every other write targets one cabinet.
- Read-only install mode for clients who allow diagnostics only.
- Safety net: network and firewall changes revert themselves if the cabinet loses contact with the server for 2 minutes.
- Firewall profiles turned off come back on automatically after their time limit, which survives reboots.
- Firewall snapshots before every change, with one-step restore.

## Control 11: integrity of alerting

- Symptom rules match structured fields and plain phrases only, never regular expressions.
- Rules from Tier 2 need Admin approval. Suppressions are Admin only, need a reason, and expire.
- Every rule has version history and can be rolled back.
- Firewall changes are attributed to the platform command that caused them; anything else raises an alert.

## Control 12: audit log

- Append-only. The database account the server uses has insert rights on the audit table but no update or delete rights.
- Tamper-evident. Each entry stores a hash of the previous entry, so any edit or deletion breaks the chain. A verification job checks the chain daily.
- Records every login and failed login, every cabinet view, every event log entry opened, every command and its result, every alert claim, every rule change, every step-up attempt and every admin action, with exact UTC timestamps.

## Control 13: monitoring

Security alerts go to Admins for unusual write volume, repeated failed logins or step-ups, sign-ins from new locations, audit chain breaks, agent self-check failures, refused packages, and connections with revoked or unknown certificates (05-server-spec.md).

## Control 14: signed upgrades

Covered fully in 07-upgrade-channel.md. The signing key never touches the server.

## Control 15: building the software safely

- The main branch is protected. Every change goes through a pull request.
- Changes to the agent, the broker, the protocol contracts and authentication code need review by two people.
- Dependencies pinned by lockfile, checked for known vulnerabilities on every build, and kept to a minimum. A software bill of materials is produced for each release.
- Release builds come only from the build pipeline, never from a developer's machine. Pipeline secrets are scoped to the jobs that need them.
- An independent security test of the agent, server and console happens before the client beta, and every serious finding is fixed before rollout continues.

## Data handling

- The diagnostic data the platform collects is not patient data. It is Windows system information: event logs, devices, drivers, network and firewall settings, and file names.
- It is still confidential client data, since it describes each client's machines and network, so it is protected accordingly.
- Collect only what diagnostics need. The Security event log and the cabinet application's data are never read.
- Every view of cabinet data is logged to the audit log.
- Secrets such as session keys and database credentials come from environment configuration or a secret store, never from the repository.
- Data at rest on the server is encrypted at the disk or database level, and backups are encrypted.

## Residual risks

These remain after every control above and should be accepted knowingly:

- A compromised server can still read diagnostic data from every cabinet, and can issue approved write operations within the agent's own rate limits.
- A trusted publisher whose own signing key is stolen could produce a malicious driver the agent would accept. Keeping the publisher list short limits this.
- Admins are trusted. Two-person approval, step-up, audit and security alerts make abuse visible and slower, not impossible.
- Enrollment fingerprints can be spoofed by someone with detailed knowledge of an install.
- The agent runs with administrator rights in its broker, as any tool that installs drivers must.

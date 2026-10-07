# Open Decisions

Each item has a recommended default, written into the other specs, so coding can start now. Change any of them before the milestone that needs it.

## Signing key location (needed by milestone 7, decide early)

Cloud KMS with hardware backing, or an offline key. Default: cloud KMS. Also decides where the agent certificate issuing key lives, needed by milestone 2.

## Hosting (needed by milestone 2)

On Mashura's own servers or in a cloud. Default: whichever your infrastructure team already runs and patches, since the server is the most valuable target in the system.

## Database hosting (needed by milestone 2)

The platform database (05-server-spec.md) runs PostgreSQL. Still to decide: a managed database service or one your team runs. Default: managed, with daily encrypted backups and a restore test before the client beta.

## Fingerprint scanner hardware IDs (needed by milestone 1)

The USB hardware IDs of each fingerprint scanner model in the fleet. Find them in Device Manager on a cabinet, under the scanner's properties, Details tab, Hardware Ids. Default: start with the model on the test cabinet and add others as they turn up.

## Trusted publisher list (needed by milestone 5, waiting on vendor details)

The signers the agent will accept for drivers and MSI installers. Default: Microsoft and the fingerprint scanner vendor only, adding others one at a time with a reason. Shorter is safer.

## Sync connection ports (needed by milestone 1)

The ports cabinets use to reach the sync cabinet, so network.test can check them. Default: confirm with the dev team; until then, test only ping and DNS.

## Event log channels turned off by default (needed by milestone 1)

Some hardware and network log channels are off in Windows by default. Turning them on gives more detail but is a change to the cabinet. Default: read what is on; decide per channel after seeing a real cabinet.

## Two-factor for Tier 1 accounts (needed by milestone 3)

Tier 2 and Admin accounts always have two-factor, because their actions need a code. For Tier 1, which is read-only, it is optional unless the admin setting requires it for everyone. Default: setting off. Turning it on means a stolen Tier 1 password alone cannot browse client cabinets.

## Console network access (needed by milestone 3)

Default: the console is reachable only from Mashura's internal network or VPN. Overnight staff working remotely connect through the VPN.

## Session timeouts (needed by milestone 3)

Overnight teams work long shifts. Default: 30 minutes idle, 12 hours absolute.

## C drive browsing depth (needed by milestone 1)

Listing only, or also downloading file contents. Default: listing only. Downloading is a data-exposure decision for a Tier 1 feature.

## Write limits (needed by milestone 5)

Default: 20 write commands per user per hour on the server, 20 write operations per cabinet per hour on the agent. Admins can raise a user's limit.

## Read-only clients (needed before the client beta)

Which clients, if any, want the agent installed in read-only mode. Default: ask each client during onboarding.

## Escalated offline alert severity (needed by milestone 4)

Whether a cabinet past the offline threshold raises a major alert or a minor one. Default: minor, configurable.

## Independent security test (needed before the client beta)

Who performs it: an internal security team or an outside firm. Default: an outside firm, testing the agent, server and console together.

## Decided

- The diagnostic data is not patient data. No healthcare compliance review is needed for it; it is still handled as confidential client data.
- The authenticator code is asked at login whenever two-factor is on for the account.

## Contract details chosen in Milestone 0 (confirm or change)

The spec did not pin these down. Each has a working default in contracts/schemas so later milestones can proceed; change the schema (and its examples) if you decide otherwise.

- **Failure codes.** Besides the eleven rejection codes, a command that started but did not succeed reports one of: execution_failed, timeout, not_found, unavailable, safety_net_rollback.
- **eventlog.query paging.** pageSize 1–500, default 100, with a beforeRecordId cursor for the next page. The spec says "100 per page, capped at 500 per call"; this reads it as a default page of 100 and a hard cap of 500.
- **network.test DNS lookups.** The schema chooses one of the four target kinds and, for dns_server, which configured server (index 0–3). Proposed: the lookup always resolves the platform server's own hostname, so no free-form name can be supplied. TCP ports must also appear in the agent's local allowed-port list.
- **firewall.setRule fields.** Addresses are IPv4 or IPv4 CIDR only (no keywords such as LocalSubnet, no IPv6); ports are lists of ranges, at most 16 entries each; programPath must be an absolute local .exe path. Rules created by the platform must be named "MashuraDiag" plus a separator and a suffix. Existing rules can be updated under their current name.
- **firewall.setProfile with no limit.** Expressed as noTimeLimit: true instead of a duration. The schema allows it; the server must still refuse it for non-Admins.
- **Server time on responses.** Every agent API response body carries serverTime (server-ack, commands-response, enroll and renew responses), rather than relying on an HTTP header.
- **Heartbeat clock skew.** An optional clockSkewSeconds field so the agent can report drift.
- **Size limits.** Single-line text 256 characters; event messages 32 KB; raw event XML 64 KB; up to 128 event data fields and 64 event detail fields; at most 50 commands per long poll; list caps of 5,000 devices or drivers and 10,000 firewall rules, with a truncated flag where relevant.
- **files.list paths.** C: only, absolute, with no "..", no alternate data streams, wildcards, UNC or device paths. Listing is paged up to 500 entries.
- **Event severityHint.** major or minor, matching the alert severities.
- **Enrollment request.** Fingerprints also include osVersion and agentVersion. The bootstrap token is 32–128 URL-safe characters; the CSR is PEM, at most 8 KB.
- **IPv6.** Reported read-only by network.config; the write operations stay IPv4 as specified.
- **Expiry windows.** 5 minutes for reads and 2 minutes for writes are recorded in the catalog. Comparing issuedAt and expiresAt is the job of the server and agent, since JSON Schema cannot compare two fields.

## Choices made in Milestone 1 (confirm or change)

Still waiting on the client:

- **Fingerprint scanner hardware IDs and driver details.** Not yet known. The agent finds the scanner by the hardware IDs in its local configuration (scanner.hardwareIds). Until they are set, peripheral.status reports "not configured" and lists **candidates**: Biometric-class devices and devices named fingerprint or biometric, with their hardware IDs, so support can read the right ID off a real cabinet. The spec's handoff asks for these before Milestone 1 is finished.
- **Sync cabinet address and ports.** Not yet known. syncCabinet.address is empty, so tests to the sync cabinet report unavailable. Ping and DNS tests work to the gateway, the DNS servers and the platform server; TCP tests are refused until a port is in allowedTcpPorts.

Decided here, open to change:

- **Readable event logs widened from 13 to 41 channels.** The client asked for "every log that could be important, from hardware to program logs". The list (contracts/schemas/common.schema.json allowedLog) covers hardware errors, devices and drivers, USB and biometrics, storage, network, time, updates, Defender, task scheduler, group policy and print administration. Channels that record sign-ins, credentials, remote sessions, typed commands or printed document names are excluded and a test fails if one is added: Security, PowerShell, Sysmon, Winlogon, User Profile, TerminalServices, NTLM, Kerberos, CAPI2, AAD, WMI-Activity and PrintService/Operational. Channels missing on a Windows build are reported as available: false. Channel names still need confirming on a real cabinet.
- **Scanner troubleshooting checklist.** peripheral.status now also returns eight automated checks, each pass, warn, fail or unknown with a plain-language next step: device present, no Windows device error, driver installed, driver signed, USB selective suspend, reconnects in the last 24 hours (Kernel-PnP event 410; more than 3 warns), USB controller or hub errors, and the Windows Biometric Service. It also returns the USB port location, which changes when the scanner moves to a different port.
- **Malformed commands.** A command whose ID cannot be read (not JSON, too large, too deep, duplicate property names) gets no result: there is nothing to address it to. It is logged and dropped. A readable command with a malformed envelope is rejected as invalid_params.
- **Clock skew.** 2 minutes. A command is expired when it expires before it was issued, lives longer than the catalog allows, was issued more than 2 minutes in the future, or is more than 2 minutes past its expiry. Command IDs are remembered until expiry plus 2 minutes, on disk.
- **Replay versus later checks.** A command ID is recorded once it passes step 4, so resending a command that failed a later check is still a replay.
- **TCP port allow list.** Checked at step 5 and rejected as invalid_params, so nothing runs.
- **Read and network-test limits** are checked at step 6 alongside the write limit. Only the write log survives a restart.
- **Write operations** return failed / unavailable until the milestones that build them.
- **Package verification codes** (hash_mismatch, signature_invalid, publisher_not_trusted, verification_failed) are produced only by package.install, built in a later milestone, so Milestone 1 cannot test them yet.
- **Broker scope.** The broker runs eventlog.channels, eventlog.query, eventlog.get, updates.status, disk.smart and files.list. updates.status moved there after the installed-service test showed Windows Update refuses the network service's restricted account. Everything else runs in the network process without administrator rights. files.list refuses a path that goes through a junction or symbolic link.
- **Local harness inbox.** Off by default. When localHarness is on, the network service also runs command files that an administrator drops into an admin-only folder, through the full checks and the real broker pipe. This exists for testing on a cabinet without a server.

## Choices made in Milestone 2 (confirm or change)

- **Approval before the console exists.** Approving cabinets, creating bootstrap tokens and issuing read commands is done with the `platform-admin` command line, run by a named person (`--as`). Every action is audited, and approval needs an Admin. Milestone 3 moves these to the console with sign-in and step-up. The CLI cannot issue write operations.
- **Users table now.** The audit log and commands need a person's ID, so a minimal users table (username, name, role, status) exists from this milestone. Milestone 3 adds passwords, two-factor and sessions.
- **Audit log account.** The spec asks for audit entries in the same transaction as the action, and for a database account that can only insert into the audit table. Both hold this way:
  - The server's account cannot touch the audit table directly. It calls `audit_append()`, which runs as `cabinet_audit_writer`, a role that can only insert entries and move the chain head.
  - Triggers refuse UPDATE, DELETE and TRUNCATE on the table, even from its owner.
- **Certificate issuing without a library.** Node's built-in crypto plus a small DER encoder issues the certificates. This avoids about ten extra packages, and the signing step is the single function `signTbs`, which matches a KMS sign call. openssl verifies the output in the tests.
- **Agent certificates.** They are ECDSA P-256 and valid for 90 days:
  - The subject and SAN URI carry the cabinet ID, and the certificate is usable for TLS client authentication only.
  - The agent renews in the last 30 days, and the server refuses renewal earlier, so a stolen certificate cannot extend itself.
  - The key stays the same across renewals.
- **Agent key storage.** The installer generates the key on the cabinet, as an administrator, in the Windows machine key store (software key storage provider), non-exportable.
  - Its access list admits only SYSTEM, administrators and the network service.
  - The network service only opens the key and never creates one. Windows refuses machine-key creation to the restricted service account, which the installed-service test showed.
  - TPM-backed storage could follow if every cabinet has a TPM.
- **Server trust on the agent.** The agent trusts only the platform CA file the installer copies, not the Windows root store. In development, the same development CA signs the agent API's own TLS certificate.
- **Command delivery.** A command is handed to the agent once. If that response is lost, the command simply expires. Re-delivering it would be refused by the agent as a replay anyway.
- **Bootstrap tokens.** Tokens are single-use and expire after 7 days, and only a hash is stored. The agent deletes its token file once the server has accepted it. If a token is consumed but the response is lost, the cabinet needs a new token.
- **Events** are stored as they arrive, with duplicates ignored. Turning them into alerts is Milestone 4.
- **Proactive drive replacement (from the client).** The goal includes warning early enough to send a client a new hard drive before a crash. Milestone 4's drive monitor should therefore raise "Drive failing" on worsening SMART counters (new reallocated or pending sectors, uncorrectable errors, high wear), not only on Windows' own failure prediction. It should show the trend per drive.

## Choices made in Milestone 3 (confirm or change)

- **Scanner hardware IDs from the console (client request).**
  - An Admin sets a fleet default, and Tier 2 or Admin can set a per-cabinet override. Each change needs step-up and is audited.
  - The server puts the IDs into every `peripheral.status` command. The cabinet's local configuration remains the fallback.
  - The scanner check lists likely scanners with a one-click "Use as this cabinet's scanner".
- **Sync cabinet from the console (client request, "guarded console setting").**
  - An Admin sets each site's sync address (private IPv4 only) and up to 4 TCP ports, with step-up and an audit entry.
  - The server puts them into sync-cabinet network tests, replacing anything the browser sent.
  - Each cabinet still refuses an address that is not a private address on one of its own connected networks (/16 or narrower). So a compromised server can test only hosts on the cabinet's own LAN, on at most 4 ports, within the existing 10-tests-per-minute limit.
  - This relaxes the spec's "TCP ports only from local configuration" rule for the sync cabinet alone; the client chose it.
- **Creating accounts.** Users are created with the `platform-admin` CLI until the Users admin screen arrives in Milestone 6. The CLI prints a temporary password, which must be changed at first sign-in.
- **Authenticator setup** shows the key as text (grouped in fours) and an `otpauth://` link, not a QR code, to avoid adding a QR library. A QR code can be added if wanted.
- **Approval moved into the console.** Pending cabinets, install tokens and revoking cabinets now use the console with step-up. The CLI still works.
- **Audit action names.** The log records `cabinet.view` when a cabinet is opened, `eventlog.browse` when a log is read, and `eventlog.entry.open` when an entry is opened in full. Sign-in steps are `auth.*`, and settings changes are `settings.scanner`, `cabinet.scanner` and `site.sync`.
- **The live stream** carries command results. Major alerts and claims joined it in Milestone 4.
- **Getting-started tour** (client request). It opens at first sign-in and can be re-run from the Account page.
- **Not yet in the cabinet view:** the Alerts and Software sections, and the issue mapping and fleet counts in event detail, arrive with Milestones 4 and 5.

## Choices made in Milestone 4 (confirm or change)

- **Scanner events have their own kind.** The fingerprint scanner watcher sends `kind: "scanner"` events carrying the device and its state (`disconnected`, `device_error`, `driver_missing`, `recovered`) instead of a Windows log record. The built-in rule maps them to Fingerprint scanner problem, and a `recovered` event resolves that cabinet's open scanner alert on its own.
- **Monitor settings come with the heartbeat.** The server's heartbeat answer is now a `heartbeat-response` carrying the scanner hardware IDs set in the console (the cabinet's own, else the fleet default). It is data only and cannot start an operation. The agent keeps the last answer on disk, so the watcher keeps working while the server is unreachable. The cabinet's local configuration file is the fallback until the console has sent IDs.
- **What the monitors watch, and how often.**
  - Event logs: Error and Critical entries in every allowed log that is turned on, every 2 minutes, through the broker. The first look at a log goes back 24 hours, so problems from just before the install are seen. At most 500 new entries per log per look are taken.
  - Fingerprint scanner: Device Manager every 60 seconds. It raises an event when a problem starts or changes (a new error code counts as a change), and again on recovery. It stays quiet while no hardware IDs are set.
  - Drive health: once a day, starting 10 minutes after the service starts. The drive is reported on its own failure prediction, a Windows health warning, any reallocated, pending or uncorrectable sectors, wear of 80% or more, or 60 °C or hotter. After that it is reported again only when it gets worse (a new reason, a rising counter, or 5 more points of wear). This is the early-warning for sending a client a new drive before a crash. Failure prediction, failing health, pending sectors and uncorrectable errors are marked major; early wear is marked minor. Thresholds can change.
  - Firewall: the full configuration is fingerprinted every 5 minutes, and at once when the firewall log records a rule or setting change. The first look is a baseline. Changes report how many rules were added, removed and changed, with their names.
- **The event queue** holds up to 5,000 events on disk, drops the oldest first, and sends oldest first in batches of 100. An event-log entry's event ID is derived from its log and record, so a resend can never be counted twice.
- **Unrecognized errors** are grouped by log, source (ignoring case) and event ID. Other unmatched kinds (agent status, security) are grouped by kind.
- **Rules people write must name something specific:** a source, event ID, hardware ID or message phrase. A rule on only a log or a level is refused, because it would swallow every unrecognized error in that log. The phrase is a plain, case-insensitive substring of at least 3 characters. When several rules match, the most specific wins, and on a tie the oldest.
- **Who can resolve an alert.** The person who claimed it, or any Admin. An open alert must be claimed before a Tier 1 or Tier 2 user resolves it. A note on what fixed it is optional.
- **Rollback** restores an earlier version's issue and match, live, as a new version, so history is never rewritten. Only rules an Admin approved can be rolled back. Disabling or rolling back is Admin only, with step-up.
- **Regrouping** moves matching open unrecognized alerts (and their events) under the issue's alert on each cabinet when the rule goes live, and closes them as "Regrouped under …".
- **Offline threshold alert.** A built-in issue type, Cabinet offline (minor, per the default above), raised by a job that runs every minute when a cabinet has been silent longer than `alerts.offlineDays` (default 5). It resolves itself on the next heartbeat. The setting has no console screen until Milestone 6's Settings.
- **Live stream.** New major alerts go to every signed-in console, and every claim and resolution goes to everyone, so each console shows who has what. New minor alerts are not pushed; they appear when a list is opened.
- **Left for Milestone 6, as the build plan places them there:** creating and editing issue types, the suppressions screen (the engine already honours a live suppression rule), and the offline-threshold setting screen.
- **Firewall change attribution.** A change that carries a platform command's ID is not an alert. Milestone 5 records it in the firewall history.

## Choices made in Milestone 5 (confirm or change)

- **Trusted publisher list: Microsoft only for now** (`contracts/trust/trusted-publishers.json`), still waiting on the scanner vendor's details (see "Trusted publisher list" above). The entries:
  - "Microsoft Windows Hardware Compatibility Publisher" and "Microsoft Windows", for drivers. Both are pinned to the Microsoft Root Certificate Authority 2010.
  - "Microsoft Corporation", for MSI installers, pinned to the Microsoft Root Certificate Authority 2011.

  A publisher matches only on its exact name and organization *and* a chain to its pinned root. Adding the scanner vendor is one entry plus its root certificate file.
- **Only SHA-256 or stronger signatures are accepted.** SHA-1 is accepted only as the per-file hash inside a driver catalog, because Windows still writes those.
- **The server ignores certificate validity dates when it checks an upload.** Signed packages outlive their signing certificates. On the cabinet, Windows' own WinVerifyTrust check runs after the agent's checks and handles timestamps. It does not check revocation (cabinets may be offline), and it fetches nothing from the internet.
- **MSI extended signatures.** The server checks an MSI's Authenticode signature over its contents. It does not check the separate `MsiDigitalSignatureEx` pre-hash; WinVerifyTrust checks it on the cabinet.
- **The safety net** is 2 minutes for every network and firewall write.
  - The broker records each change before making it, and keeps it only when the network service confirms it delivered the result to the server.
  - Otherwise the broker puts the old settings back, newest change first. This still happens after a restart or reboot, because the record is on disk and checked at startup.
  - The command then reports `safety_net_rollback`, and a security event is raised.

  Package installs and driver uninstalls have no safety net, because they cannot be rolled back safely.
- **Firewall snapshots.** The cabinet keeps the last 20 snapshots, taken with `netsh advfirewall export` before every firewall write. A restore saves the current firewall first, so it can be undone too.
- **Profile timers.** Turning a profile off needs a duration (1 minute to 8 hours, 60 minutes by default in the console). Only an Admin may choose no limit. The timer is kept on disk by the broker and survives a restart or reboot. The broker checks it every 5 seconds and at startup.
- **Firewall rules the platform creates** must be named `MashuraDiag …`, and are put in the group "Mashura cabinet diagnostics". Editing or deleting any rule needs its exact name, and is refused if two rules share that name.
- **The write pause and limits.**
  - Writes can be paused fleet-wide or per client. A paused cabinet still accepts diagnostics.
  - A user who goes over their hourly limit (20 by default) has their writes paused until an Admin resumes them.
  - The pause and resume controls are on the command line (`platform-admin writes pause|resume`, `user resume-writes`) until Milestone 6's Fleet safety screen.
  - The console shows the pause banner now.
- **Command-line writes skip step-up.** `platform-admin issue … --write` needs a Tier 2 or Admin account, is audited with `via: "cli"`, and still obeys every pause, limit and read-only check. It exists for operators on the server itself and for CI.
- **Package downloads.** A cabinet can download a package only while it has a delivered `package.install` command for it that is under 30 minutes old. Each download is audited. Packages are stored read-only, named by their SHA-256.
- **The Windows CI shows these on real Windows:**
  - A reboot is shown by stopping and restarting the broker service.
  - The "bad change" rollback is shown with a firewall rule and a DNS change sent through the local harness, which no server confirms.


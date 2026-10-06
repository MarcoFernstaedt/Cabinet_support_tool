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
- **Agent key storage.** The key is created by the network service in the Windows machine key store (software key storage provider), non-exportable. TPM-backed storage could follow if every cabinet has a TPM.
- **Server trust on the agent.** The agent trusts only the platform CA file the installer copies, not the Windows root store. In development, the same development CA signs the agent API's own TLS certificate.
- **Command delivery.** A command is handed to the agent once. If that response is lost, the command simply expires. Re-delivering it would be refused by the agent as a replay anyway.
- **Bootstrap tokens.** Tokens are single-use and expire after 7 days, and only a hash is stored. The agent deletes its token file once the server has accepted it. If a token is consumed but the response is lost, the cabinet needs a new token.
- **Events** are stored as they arrive, with duplicates ignored. Turning them into alerts is Milestone 4.
- **Proactive drive replacement (from the client).** The goal includes warning early enough to send a client a new hard drive before a crash. Milestone 4's drive monitor should therefore raise "Drive failing" on worsening SMART counters (new reallocated or pending sectors, uncorrectable errors, high wear), not only on Windows' own failure prediction. It should show the trend per drive.

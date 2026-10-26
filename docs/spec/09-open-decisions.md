# Open Decisions

Each item has a recommended default, written into the other specs, so coding can start now. Change any of them before the milestone that needs it.

## Signing key location (needed by milestone 7, decide early)

Cloud KMS with hardware backing, or an offline key. Default: cloud KMS. Also decides where the agent certificate issuing key lives, needed by milestone 2.

Milestone 7 built the signing for both cloud options without choosing between them: `agent/install/New-AgentRelease.ps1` signs with AWS KMS (`-AwsKmsKeyId`) or Azure Key Vault / Managed HSM (`-AzureKeyId`), through their own command-line tools, sending only the manifest's hash. **Still needed before the first real release:**
- which provider, and the P-256 signing key created in it, with only the build pipeline's identity allowed to sign;
- the key's public half committed to `contracts/trust/upgrade/upgrade-keys.json` (`agent/install/New-UpgradeTrust.ps1 -AwsKmsKeyId …` or `-PublicKeyFile …` writes it).

Until then that file holds no key, so agents built from the repository accept no upgrade at all.

## Agent code-signing certificate (needed before the first real release)

Every agent binary must be Authenticode-signed, and the agent checks its own files and every release against one pinned publisher. Needed: the organization's code-signing certificate (from a public CA, or an internal CA whose root is installed on cabinets), and its exact subject common name and organization. They go into `contracts/trust/upgrade` with the CA's root (`New-UpgradeTrust.ps1 -PublisherRootFile … -PublisherCommonName … -PublisherOrganization …`). Until then, agent builds skip the self-check and say so in their log, and refuse every release at the Authenticode check.

## Hosting (needed by milestone 2)

On Mashura's own servers or in a cloud. Default: whichever your infrastructure team already runs and patches, since the server is the most valuable target in the system.

## Database hosting (needed by milestone 2)

The platform database (05-server-spec.md) runs Microsoft SQL Server 2022 (decided by the owner in October 2026, replacing PostgreSQL; nothing had been deployed on it, so the schema is one consolidated T-SQL baseline). Still to decide: the edition (Express is free and fits a small deployment; Standard or Enterprise for more) and a managed database service or one your team runs. Default: managed, with daily encrypted backups and a restore test before the client beta.

## Fingerprint scanner hardware IDs (needed by milestone 1)

The USB hardware IDs of each fingerprint scanner model in the fleet. Find them in Device Manager on a cabinet, under the scanner's properties, Details tab, Hardware Ids. Default: start with the model on the test cabinet and add others as they turn up.

**No longer blocks anything:** they are set in the console, for the whole fleet, one client, one site or one cabinet. Until they are set, each cabinet finds its scanner automatically (the Biometric device). The scanner page lists the likely devices with a button to adopt one for the client. See "Device settings that follow the client" below.

## Trusted publisher list (needed by milestone 5, waiting on vendor details)

The signers the agent will accept for drivers and MSI installers. Default: Microsoft and the fingerprint scanner vendor only, adding others one at a time with a reason. Shorter is safer.

## Sync connection ports (needed by milestone 1)

The ports cabinets use to reach the sync cabinet, so network.test can check them. Default: confirm with the dev team; until then, test only ping and DNS.

**No longer blocks anything:** they are set in the console, for the whole fleet, one client, or one site, with the site's address. See "Device settings that follow the client" below.

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
- **Alerts (decided by the product owner after Milestone 6):**
  - **What is captured:** every event-log error that could cause problems on a cabinet, including the ones that commonly come before a drive failure.
  - **Severity decides where an alert shows.** Major alerts show on the home page and in the Alerts tab. Minor alerts show only when someone opens the cabinet. This replaces "minor alerts appear in the list" in 06-console-spec.md.
  - **Severity can be set per symptom.** Each mapping chooses its issue type and its own severity, so one issue (Drive failing) can be minor for an early sign and major for a real failure.
  - **Errors nobody planned for** stay in the Unrecognized list. There anyone can map them to an existing issue type, and an Admin can create a new issue type on the spot.

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

- **Approval before the console exists.** Approving cabinets, creating bootstrap tokens and issuing read commands is done with the `platform-admin` command line, run by a named person (`--as`). Every action is audited, and approval needs an Admin. Milestone 3 moves these to the console with sign-in and step-up. Since Milestone 5 the CLI can also issue a write, but only with `--write`, by a named Tier 2 or Admin, under the same role, Admin-only and approved-package rules as the console (one shared code path), audited as "via cli". Step-up is not asked there: the CLI runs only on the server host, by someone who already holds its database credentials.
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


## Agent self-check (resolved)

04-agent-spec.md says the binaries are Authenticode-signed and that the agent checks the signature on its own files at startup, reporting any mismatch as a security event. (An earlier note here wrongly said the spec did not define it.) The product owner confirmed it is built with Milestone 7, alongside the signed updater.

## Choices made in Milestone 6 (confirm or change)

- **Security alerts are their own list, for Admins only.** Most of them concern people, not cabinets, so they are not cabinet alerts.
  - Repeats fold into one open alert with a count, so a flood stays one line.
  - Admins see a count on the Admin link, and new ones appear at once on their consoles.
  - Closing one needs a note on what was found, and the authenticator code.
- **When each trigger fires:**
  - **Unusual write volume:** going over the person's hourly limit, which also pauses their writes.
  - **Repeated failed sign-ins or step-ups:** the 5th failure, the one that locks the account for 15 minutes.
  - **Sign-in from a new network:** a correct password from an IPv4 /24 or IPv6 /64 the account has not used before. The account's first sign-in sets the baseline. Addresses come from the reverse proxy.
  - **Audit chain break:** found by the daily check or an Admin's "Verify the chain".
  - **Agent problems:**
    - A failed self-check (see the question above).
    - A refused package: hash mismatch, unlisted publisher or a failed check.
    - A signature failure.

    These come from the agent's security events and from its package.install results. A safety-net rollback is reported as an event but is not on the spec's list, so it raises no security alert.
  - **Certificates:** a connection with a revoked, expired, removed, mismatched or unknown certificate.
    - Folded per reason.
    - Counted at most once an hour per certificate and every 10 seconds per reason, so certificates tried from the internet cannot flood the database.
    - A caller with no certificate at all is only logged.
- **Accounts.**
  - Deleting an account keeps its history; it can never sign in again.
  - A role change also ends the person's sessions. The spec names password and authenticator resets and disabling; a new role taking effect at once is the safer reading.
  - Nobody changes their own role, disables or deletes themselves.
  - Changes to accounts run one at a time, so two Admins demoting each other at once still leave one Admin.
  - Promotion to Tier 2 or Admin needs an authenticator already set up. A new Tier 2 or Admin account sets one up at first sign-in.
- **Background requests no longer count as activity.**
  - Before this milestone, the live stream's re-check and the console's badge polls refreshed the session, so an unattended console never timed out and everyone looked online. Now they check the session without refreshing it.
  - "Online now" means a person did something in the last 5 minutes.
- **Settings in the console:**
  - offline alert threshold, 1 to 90 days;
  - idle timeout, 5 to 240 minutes, and absolute timeout, 1 to 24 hours;
  - require two-factor for every account. Turning it on signs out everyone without an authenticator; they set one up at their next sign-in.
  - retention: events and command results 7 to 3,650 days; resolved alerts and firewall history 30 to 3,650 days.
- **Retention runs daily.**
  - It deletes old events, resolved alerts and firewall history.
  - It clears old command results; the command itself (who ran what, when) stays.
  - It removes expired sessions and step-up tokens.
  - The audit log is never pruned. The chain check reads it in batches, so its size does not matter.
- **Clients and sites** are removed only when no active or pending cabinet is left. They are kept, marked removed, with their history, and their names can be used again.
- **Suppressions** are created on the Issue types and suppressions screen: match fields plus a written reason of at least 10 characters. A job checks every minute and marks expired ones, with history.
- **"Who opened this cabinet"** is a link on the cabinet page for Admins. It opens the audit log filtered to that cabinet's views. The audit search also takes a family of actions such as `user.`.
- **Cabinet role** (sync, satellite, standalone) is changed by an Admin on the cabinet's overview.
  - The role is chosen when the request is approved, together with what that role needs to work, so a cabinet is not approved into a state it cannot use and then fixed afterwards.
  - **A satellite is refused (409, `satellite_needs_sync`) when its site has no sync cabinet address.** This tightens what used to be allowed: an approval that would have left a satellite with nothing to reach now says to enter the sync cabinet's private IPv4 address with the approval, or to approve the sync cabinet first. The address may be given in the same approval, so a site's first satellite does not need a second screen.
  - **A site has one live sync cabinet** (`status <> 'removed'`), enforced when the cabinet is approved: a second one is refused (409, `sync_exists`), under the same transaction's lock, so two approvals at the same moment leave exactly one. Changing a cabinet's role on its overview is still how an existing sync cabinet becomes a satellite or standalone.
  - A **sync** cabinet is the endpoint its satellites and their network checks reach, so it is not given a sync address: an approval that carries one is refused (400, `sync_not_allowed`), rather than the address being ignored.
  - The address the approval writes is the site's own setting (`sites.sync_address`, `sites.sync_ports`, the pair the Device defaults screen writes), validated by the same rule: a private IPv4 address, and at most four whole ports. It is written in the approving transaction, so a refused or failed approval leaves neither a cabinet nor an address behind.

## Choices made for the alert changes (confirm or change)

- **Warnings are collected from the logs where hardware trouble shows first:** System, HardwareEvents, WHEA, Storport, ClassPnP, Storage Spaces, NTFS and thermal.
  - Every other allowed log gives Critical and Error only, as before.
  - A warning that matches no rule is stored on its cabinet, where it can be mapped, but raises no alert; otherwise every chatty driver would fill the Unrecognized list. An unmatched error still becomes an unrecognized alert.
- **A starting catalog of 33 built-in rules (migration 0006):**
  - Drive failing: disk 7, 11, 52, 154 major; disk 15, 51, 153 minor; NTFS 55, 98 major and 140 minor; storahci, stornvme, iaStorA and iaStorAVC controller resets (129) minor.
  - Hardware error (new, major): WHEA 18 major; 17, 19, 47 minor.
  - System crash (new, major): bug check 1001.
  - Unexpected shutdown or power loss (new, minor): Kernel-Power 41, EventLog 6008.
  - Windows service failure (new, minor): Service Control Manager 7000, 7009, 7011, 7023, 7031, 7034.
  - Network connectivity: Tcpip 4199 address conflict (major), DNS Client 1014 (minor).
  - Driver failure: Kernel-PnP 219. Windows update failure: WindowsUpdateClient 20.

  These are a starting point from common Windows knowledge. Check them against real cabinets; any can be disabled, and Map to issue adds more.
- **An alert's severity only goes up.** When a more serious symptom of the same issue arrives on a cabinet, the alert becomes major and is announced to every console like a new major alert. It does not drop back to minor on its own.
- **Home page and client pages** count major alerts only. The site page and the cabinet sidebar still count every open alert, since they are about single cabinets.
- **Creating a new issue type from Map to issue** is for Admins only (issue types are Admin-only in the spec). It uses one authenticator code for both the type and the rule. Tier 2 maps to the closest issue type or asks an Admin.


## Choices made in Milestone 7 (confirm or change)

- **Release files.**
  - The manifest is JSON: product, version, minimum version, SHA-256 and size of the zip, release time, optional notes.
  - The signature is ECDSA P-256 over the SHA-256 of the manifest's exact bytes, DER-encoded. Both AWS KMS and Azure Key Vault offer this key type.
  - The signature file names its key by the SHA-256 of the public key. That lets an agent hold the current key and one future key (at most two), as the spec asks.
- **Downloads.** The spec's `GET /agent/v1/updates/{version}` returns the manifest (base64, so it arrives byte for byte) and its signature. The zip is `GET /agent/v1/updates/{version}/package`. Both are served only to a cabinet the rollout has offered that version to, and each zip download is audited.
- **Order of the agent's checks:**
  1. the manifest's signature against the compiled-in key;
  2. the zip's hash and size against the manifest;
  3. the version (newer than the running one, and the running one at least the release's minimum);
  4. Authenticode and the pinned publisher on every file Windows could load as code.
  The release must also contain the broker, network service and updater programs. A refusal names its check, and is also sent as a security event, so Admins see it among the security alerts.
- **The updater.**
  - It is the installed version's own updater, copied into the broker's folder before it runs, so it can replace the program folder.
  - The broker starts it as SYSTEM with one fixed word (`run` or `resume`) and no paths.
  - The previous version is kept as `Program Files\Mashura\CabinetAgent.previous` until the next upgrade.
  - "Checked in" means the new network service reached the server with a heartbeat after the install.
  - Every step is written to a journal first. If the cabinet restarts mid-upgrade, the broker finishes or undoes it at start-up.
- **Batches.** Batch 1 is one cabinet the Admin picks. Batch 2 is the cabinets an Admin has marked "in office" (a flag on the Upgrades screen). Batch 3 is 5% of the remaining cabinets, rounded up and picked at random. Batch 4 is the rest. Empty batches are skipped. Cabinets already on that version or newer are left out.
- **Thresholds** are chosen per rollout. The defaults are 95% success and a 5% failure limit; the success rate cannot be set below 50% or the failure limit above 50%.
  - Cabinets that are offline do not count against a batch's success rate. After 24 hours they are skipped, and they are still offered the version if they come back while the rollout runs.
  - An offered cabinet that reports nothing within 30 minutes counts as failed.
  - Resuming after an automatic pause accepts the failures so far. Only new failures count toward the limit again.
- **One rollout at a time.** "Roll back" in the console is **Stop**: no more cabinets are offered the version. Going back means publishing the older code as a new release with a higher version and rolling that out, as the spec says. The server refuses any release whose version is not higher than every earlier one.
- **The self-check** runs in the network service at start-up and daily, over every binary in the program folder. It reports changed, unsigned or wrongly signed files, and missing service programs, as a security event (`self_check`).
- **The server's update store** keeps each manifest in the database and the zip read-only under `data/releases` (`RELEASE_DIR`). Uploads are checked against the keys in `contracts/trust/upgrade`. `UPGRADE_KEYS_DIR` points elsewhere for tests and refuses to run in production. An upload with a bad signature raises a security alert. Only the Admin who added a release may upload its package.
- **Release tooling** is PowerShell, so it runs where the Windows build signs the binaries. It uses .NET's own cryptography and the cloud providers' command-line tools, and adds no dependencies. The `-DevKeyFile` key and `-p:UpgradeTrustDir` exist for test builds only.

## Device settings that follow the client (requested after Milestone 7; confirm or change)

The product owner asked that the scanner's hardware IDs and the sync ports be set per client and stay dynamic, so changing a client's scanner keeps working.

- **Scanner hardware IDs.**
  - They can be set for the fleet, a client, a site or a cabinet. The most specific one applies: cabinet, then site, then client, then fleet.
  - Cabinets get the IDs in every heartbeat answer and in each scanner check, so a change applies within a minute, with nothing installed.
  - Tier 2 and Admin may change a client's, a site's or a cabinet's IDs. These change only which device the checks watch. The fleet default stays Admin only. Every change needs step-up and is audited.
- **Vendor IDs.**
  - An ID may be a vendor prefix such as `USB\VID_1234`, which matches every model from that vendor. A prefix matches only up to an "&" boundary, so `USB\VID_12` does not match `USB\VID_1234`.
  - A client that changes to another model from the same vendor needs no change. Listing both models works while a client changes over.
- **Automatic when nothing is set.**
  - With no IDs set anywhere, the agent treats the Biometric-class device as the scanner. A connected one wins over one Windows only remembers, so a swapped scanner is followed.
  - It stays quiet until Windows has seen a Biometric device, so a cabinet without a scanner raises nothing.
  - Setting IDs in the console pins the scanner and turns this off. The scanner page shows "Found automatically" and lists the devices, with "Use this model" or "Any model from this vendor" for the cabinet, its site or its whole client.
- **Sync ports.**
  - They can be set for the fleet, a client, or a site (with the site's address). The site's own ports apply, then the client's, then the fleet's.
  - The address stays per site, since it is a site's own machine. Changes are Admin only, with step-up and an audit entry.
  - Cabinets still accept only a private address on their own network, and only the ports these settings list for the sync cabinet.
- **Not made dynamic:** the platform server's address and port, and the TCP ports allowed for tests to other targets. They stay in the cabinet's local configuration. The first is how a cabinet finds the server at all. The second is the spec's guard against using tests to scan a client's network; only the sync cabinet's ports were relaxed, by the earlier client decision.

## Load test (done; repeat before going wide)

The build plan asks for a load test of the agent API with 8,000 simulated agents polling before going wide. `server/test/load/agents.ts` does it with real certificates, held long polls, heartbeats, events and command round trips.

On one 4-core development machine shared by the server, the database and the load generator, 8,000 agents ran for 10 minutes with no failures: heartbeat p95 18 ms, command delivery p95 13 ms (details in server/README.md). CI repeats a 1,000-agent version on every push.

**Still to do (a rollout gate):** run it against the production hosting and database, with the load generator on a separate machine, once hosting is decided. The thresholds are in the tool (THRESHOLDS); confirm or change them.

## Milestones 8 to 12 (decided, October 2026)

Asked of and answered by the product owner; specified in 12-milestones-8-to-12.md.

- **Firewall default.** Each client has a firewall policy, all three profiles off by default, because that fixes most satellite-to-sync connection problems. Drift is shown and raises a minor alert; a person applies the policy with one click. The platform never applies it on its own (the product owner chose this over automatic enforcement).
- **Who may change the firewall.** Tier 1 and Tier 2, including no time limit. Allow-all inbound rules are no longer Admin only, since the same people may turn the firewall off.
- **Confirmation.** The product owner asked that single-cabinet fixes not slow staff down, and that bulk changes need a second confirmation such as the password. Adopted, with one addition recommended to and accepted by the owner: rare changes that can strand or alter a cabinet (static IP and DNS servers, packages, driver removal, firewall restore) keep the authenticator code. Every account needs an authenticator at sign-in.
- **Watched services.** Tier 2 and Admin choose them; the broker restarts them; 3 failed restarts in a row raise a major alert. The broker never starts a disabled service, never changes a start type, and never starts remote-access services.
- **Health checks.** Collected by the agent itself once a day (a `health` event) rather than by commands the server issues at night, so no command is ever issued without a person behind it.
- **Network lookups.** network.resolve accepts any host name but queries only the DNS servers configured on the cabinet; traceroute keeps the four fixed target kinds, so the platform still cannot be used to map a client's network.

## Before milestone 11 (decided, October 2026)

Asked of and answered by the product owner; specified in 12-milestones-8-to-12.md under "Milestone 11 additions" and "Console redesign".

- **Installing Windows updates.** Tier 1, Tier 2 and Admin, with one click; the confirmation says updates can take a long time. Security and quality updates only: never Windows version upgrades, and never drivers from Windows Update (drivers come from the software library). Updates come from Microsoft or the client's WSUS through the Windows Update Agent, never from the platform.
- **Restart after updates.** Never automatic. The cabinet shows "restart pending" and a person restarts it now or schedules it.
- **Restarting a cabinet.** All tiers, now or at a scheduled time, one click. Most cabinets already restart on a routine; the platform shows the pending-reboot state alongside.
- **Bulk updates and restarts.** Allowed for a client or a site, confirmed with the password like the bulk firewall policy, up to 200 cabinets; bulk restarts are staggered.
- **Cable or switch-port faults.** No packet capture. The diagnosis shows a physical-layer finding when the evidence supports it (no link, a gigabit port linking at 100 Mbps or less, rising receive errors, link up/down events), each paired with what to do. Every finding comes with its fix.
- **Accounts.** Admin can do everything Tier 2 can, plus enrolment and user management (already so). A new account and an Admin password reset both force a new password at the next sign-in (already so; kept under test).
- **Console redesign.** The product owner's brand: Midnight Navy and Electric Cyan, a dark interface, with status colours green, amber, red and blue, always with a text label. Tokens are centralised; existing workflows and security controls are kept.

## Demo and the module list (decided, October 2026)

- **Demo.**
  - The platform runs on the owner's VPS (deploy/).
  - Demo mode is a switch an Admin turns on or off on Admin → Set up and demo. It adds simulated clients, sites and cabinets next to the real ones, marked Demo everywhere, and deletes them when turned off.
  - The owner's real laptop is enrolled from the same page.
  - Simulated cabinets answer through the real server paths and contracts, so they never show something a real cabinet could not (docs/platform/demo.md).
- **Scripts.**
  - Kept out, as recommended: every capability is a fixed operation.
  - The owner would accept signed scripts only if they can be made safe. That stays open: it changes the security model (Admin-approved, code-signed, two-person approval, verified on the cabinet, run by the broker with typed parameters) and needs its own design before any work.
  - Configuration files reach cabinets only as signed library packages.
- **Crash dumps and packet captures.**
  - The owner chose all three: crash metadata, minidump upload, and short packet captures.
  - The proposed safeguards for uploads and captures, to confirm when phase 2 is specified: Admin only, an authenticator code, encrypted in transit and at rest, kept 30 days, every access audited.
  - Captures are limited to 60 seconds, one host or port, and a size cap.
  - The Security log stays unreadable.
- **Order.** Blue screens and storage first; then network, updates, restarts and time; then fleet operations and the support call workflow (docs/spec/13-roadmap.md).
- **Excluded by the owner:** Wake-on-LAN, and every database diagnostic or repair.
- **Fingerprint scanners.** The owner confirmed two DigitalPersona models in the field: "DigitalPersona" and "DigitalPersona 36". Lumidigm is named in the module list but not confirmed as deployed.
- **Still to confirm:** each scanner model's USB hardware IDs and the vendor service it needs. Until then the platform finds scanners automatically (the Biometric device class) and a technician can pick the model on the cabinet's Fingerprint scanner page.

## From the October 2026 security review

See docs/platform/security-review.md and docs/platform/threat-model.md.

- **Tenant isolation.** Every signed-in person sees every client, because Mashura's support team supports them all. If clients or partners ever get accounts, each account needs a client scope enforced in every query, with tests. Open until that need exists.
- **Firewall rules Tier 2 may change.** Tier 2 can change or delete any Windows firewall rule by its exact name, including Windows' own. Should built-in rules be read-only? Open for the product owner.
- **Driver trust.** Drivers signed by Microsoft's hardware publisher are accepted when their class is allowed and a second Admin approves them. An allow-list of approved driver catalogs would be stricter; open.

## Emergency offline access (milestone 14)

Design: [14-emergency-access.md](14-emergency-access.md). To decide before it is built:

1. **How the credential reaches the customer.** A signed credential is about 125 characters (about 25 groups of 5), too long to read aloud comfortably. Options: the technician texts or emails it and the customer types or pastes it (proposed), read aloud in checked groups, or a file on a USB stick. A shorter code would need a shared secret instead of a signature, which the requirement rules out.
2. **Who may grant each level.** Proposed: Level 1 and 2 by Tier 1 and up, Level 3 by Tier 2 and up; each with an authenticator code.
3. **Time limits.** Proposed: a challenge lasts 30 minutes; a session up to 60 minutes (Level 1 and 2) or 30 (Level 3).
4. **When a cabinet counts as offline.** Proposed: no contact with the server for 5 minutes.
5. **Reconnection.** Proposed: reconnecting ends the emergency session; support carries on from the central console.
6. **The signing key.** A dedicated key on the server: held in a cloud key service (proposed) or in a file on the VPS outside the repository.
7. **New operations for Level 3.** Renewing a DHCP lease is now in the catalog (`network.renewLease`); restarting an approved application is not, and adding it needs a signed agent upgrade. Approve or leave out.
8. **Notifications.** Today Admins see security alerts in the console. Email or text notifications are not built; say whether they are needed.

## Network troubleshooting (October 2026)

Built as described in [16-network-troubleshooting.md](16-network-troubleshooting.md). To confirm:

1. **Confirmation for network fixes.** Changing a DNS server or an address keeps the authenticator code for one cabinet (a mistake can cut a cabinet off; the safety net rolls it back). The same change on several cabinets uses the password, as other bulk changes do. If you want a single click for DNS fixes, say so: the safety net is what makes that reasonable.
2. **Fixed-address sites.** A site whose cabinets have fixed addresses can have its gateway corrected remotely, but a wrong address cannot: the platform does not know which address each cabinet should have. An address list per site would allow that.
3. **How often the baseline is compared.** Today a cabinet is compared when someone runs the diagnosis (and the demo seeds the alert a regular check would raise). A scheduled nightly check of every cabinet against its baseline is not built.
4. **DHCP lease renewal.** Decided: a separate `network.renewLease` operation (Tier 1, a click, no setting changes, no safety net) is built; it needs the agent upgrade that carries it. Switching to DHCP with `network.setIp` stays for a fixed address that should not be fixed.

### Full network read, site standards and known fixes (October 2026)

All of this is built on `main`; the design is in [16-network-troubleshooting.md](16-network-troubleshooting.md). Still to confirm:

5. **`network.trace`.** A new read-only operation (Tier 1, 12 a minute per cabinet) that sends ICMP probes with a rising time-to-live from the unprivileged network service, with no external program. Some firewalls drop those probes, so silent hops are shown as silent, not as failures. Keep it or leave it out.
6. **Bigger network reads.** `network.config` now returns each card's DHCP server, lease times, MTU and counters, plus up to 128 routes and 64 ARP entries. `network.test` takes a ping `count` (1 to 10) and returns loss and jitter. Cabinets need the 0.2.0 agent for these. The Windows readers haven't run on Windows yet.
7. **Migration numbers.** `main` has 0019 to 0022. The `baseline-recovery` branch has its own 0019, so one side gets renumbered when they meet.
8. **Agent version.** The agent projects are 0.2.0. Release with `New-AgentRelease.ps1 -Version 0.2.0 -MinimumVersion 0.1.0`. Cabinets still on 0.1.x answer the new reads with an error, and the diagnosis says "not traced".
9. **Known fixes.** Decided: a member submits, an Admin or a granted Tier 2 approves, and an approver's own fix needs no second approver (a confirmation dialog, then it is logged). Fixes never expire. A fix applies to every cabinet in the fleet. A fix saved from an alert is written into the alert's resolution.
10. **Demo fleet.** Four clients with one to seven sites each, single-cabinet sites, and large sites of 20 (Harbor is four sites of 20). The guided demo is one story and ends by onboarding a real agent.
11. **Live test.** "Test <cabinet>" runs eleven read-only checks on one cabinet and can copy a plain report ([live-test.md](../platform/live-test.md)). It also shows on simulated cabinets, marked as simulated.

## Troubleshooting reads (handbook round)

- Raised the `network.test` ping count limit from 10 to 20 so packet loss has more samples. Say if you want a different ceiling; the rate limit for network tests is unchanged.
- Did not add the network connection category (Public/Private/Domain) to `network.config`. Open: do you want it as its own field, or is the firewall profile in the firewall read enough?
- `system.performance` is a single WMI snapshot, not an average over time. Open: do you want a short sampling window (for example three samples a second apart) on the agent?

## Rolling back Windows

- Added `updates.uninstall` (roll back one installed update by KB number, never restarts). It does not roll back a whole Windows version (the "Go back to the previous version" feature) or use System Restore points: those are larger, harder to undo and need a decision on which cabinets may use them. Open: do you want either, and who may run them?
- `wusa.exe` is now on the list of programs the broker may start (`pnputil`, `msiexec`, `netsh`, `tzutil`, `w32tm`, `wusa`).

## Reviews of the case-notes, watch, compare and port-check round

Two independent reviews (server and console; agent) found no critical or high defects. Fixed: the port check no longer says "nothing is listening" or "blocked" when the listener or rule list was cut short, and treats rules limited to a program or address as "limited" rather than allowed; a watch sample the cabinet refused or did not answer no longer counts as packet loss; compare pairs adapters by name, keeps duplicate rule names and shows when its list is cut at 200; the activity report reads only the error code of each command; listener counts are not silently capped at 5,000; control characters in SSIDs and profile names are replaced; a 20-ping series uses 2-second timeouts so a dead target reports 100% loss instead of timing out.

TCP series are limited to 10 attempts (ping stays at 20): answered by the team, enforced in the network.test contract and so by the agent.

### Cash drawer check

Built as a panel on the Network tab from existing reads (`network.config` twice, `firewall.state`) and the existing `firewall.setProfile`. The drawer network is `172.20.1.0/24` (the team first wrote 176.20.1.0 and confirmed 172). The check matches the whole /24. Open: should the range be an Admin platform setting instead of a constant in `console/src/lib/drawer.ts` and `server/src/diagnose/network-findings.ts`? Left as a constant.

### Service start types (answered)

Owner: Tier 1 and Tier 2 can change a service's start type. Built as `service.setStartType` (Tier 1 and up, one click, the same refused list as service.control, drivers never). Registry and scheduled-task changes: not answered, not built. Driver and whole-Windows rollback: not for now. DigitalPersona hardware IDs: to follow.

### Which standards need an authenticator code (decided)

The cabinet's **Standards** tab lists every setting a cabinet is held to (firewall policy, network baseline, time zone, sync cabinet, scanner IDs, watched services) with the standard, the level it comes from, and what the cabinet reports; a line opens a window with every level and the editors.

A code on an edit helps only against one threat: someone using a signed-in browser session that is not theirs (a stolen cookie, an unlocked workstation). It does not help against a compromised server, which can write the database and issue commands without any console code; what limits that is on the agent: the fixed operation catalog, schema checks on every input, private-address-only sync targets, signed packages and upgrades, and the safety net that undoes a change that cuts a cabinet off. So a code is kept only where a hijacked session could do harm that reaches cabinets or traffic, and dropped where the setting changes no cabinet and any later change to a cabinet has its own confirmation:

| Setting | Code? | Why |
|---|---|---|
| Client and fleet firewall policy | Yes (Admin) | It decides how every cabinet of the client is told to set its firewall; a hijacked session could weaken them all. |
| Sync cabinet address and ports (site, client, fleet) | Yes (Admin) | It decides where every cabinet's connection test and the checks after it are pointed. |
| Network baseline | No (Tier 2 and up, one click) | It changes no cabinet. The diagnosis only proposes fixes, and each fix that changes an address or DNS asks for its own code with the exact values. |
| Scanner hardware IDs (fleet, client, site, cabinet) | No (Tier 2 and up, one click) | It changes only which device the scanner checks look at. Installing a driver is a separate step with its own code. |
| Site time zone, watched services | No (already one click) | Time zone changes no cabinet; the watch list only restarts services, never changes a start type, and refuses remote-access services. |

Every edit is role-limited and audited with who, what and the before and after. A one-time token sent to the scanner or baseline endpoints is still accepted and used up, so older clients keep working.

### Decisions, October 2026 (owner)

- **Tier 2 may change or delete any Windows firewall rule by exact name** (C8): yes. It stays audited and bounded by the safety net.
- **No second approvals** for policy changes unless clearly better; the authenticator code on firewall policy and sync-cabinet changes stands as decided above.
- **No printer features** (queue, spooler clearing, printer reads).
- **No email, chat or Salesforce integration.** Case notes stay copy and paste.
- **New device sign-ins are shown.** The server remembers each browser by a random device cookie (only its hash is stored). A sign-in from a device or network the account had not used before is marked in the person's own sign-in list, announced to them right after sign-in, listed for Admins, and raises a security alert. An account's first device is not "new".
- **Cookies** carry the `__Host-` prefix (C6): Secure, HttpOnly, SameSite=Strict, Path=/, no Domain. Everyone is signed out once when this is deployed.

### Support actions and Windows reads, October 2026 (built, not yet run on a real cabinet)

Nine new read-only checks (`system.security`, `software.list`, `startup.list`, `sessions.list`, `shares.list`, `reliability.list`, `disk.folders`, `dns.cache`, `power.status`) and four actions, all in the fixed catalog, served by the broker:

| Operation | Who | Confirmation | What it runs |
|---|---|---|---|
| `system.restart` | Tier 2 (shutdown: Admin only) | authenticator code, bound to the parameters | `shutdown.exe` by full path, argument array, message as one element; delay 0 to 3600 s; `cancel` runs `shutdown /a`. |
| `process.end` | Tier 2 | authenticator code | Ends one process named by ID **and** name together. Windows' own processes, the security software, remote-access tools and the agent are refused (compiled-in list). |
| `system.checkHealth` | Tier 1 (read) | none | `dism.exe /Online /Cleanup-Image /CheckHealth`: looks only. The answer is read by exact English phrases; anything else is "not clear". |
| `power.set` | Tier 1 | one click | USB selective suspend through `powercfg.exe` (both power sources, then re-applies the plan); Fast Startup by writing the single registry value `HiberbootEnabled`. |

- **Registry write (decision to confirm):** Fast Startup has no `powercfg` switch other than turning hibernation off, so the broker writes the one fixed value `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power\HiberbootEnabled`. No other registry value can be written; there is no generic registry operation.
- **Shutdown is Admin-only** because a shut-down cabinet stays off until someone switches it on. The server checks this; the agent has no notion of roles.
- `network.setIp` accepts a static address **without a gateway** (a link with no router, such as the cash drawer's). With no gateway the agent clears any gateway left from before; Windows may refuse the empty list on some builds, in which case the address is still set.
- `network.renewLease` accepts `release: true`: give the lease back, then ask for a new one.
- The drawer check offers **Set the drawer address** when the drawer link's address, addressing or gateway is wrong: a fixed `172.20.1.n/24` with no gateway, the last number typed by the person.
- Scheduled-task last and next run times and logon times are empty in this version (Windows needs per-task calls for them).

**Open question for the owner:** whether Fast Startup should be changeable at Tier 1 as built, or Tier 2 like the other settings that survive a restart.

### Fleet search, trends and last-known state, October 2026 (built)

- **Fleet search reads stored answers only.** It never sends a command. It matches the latest successful answer of one read per cabinet (installed programs and updates, startup items and tasks, shares, signed-in users, the DNS cache, and fixed keywords for security and power state), as a plain-text part of a name: no patterns, and `%` or `_` mean themselves. The answer says how many cabinets in scope have ever been read, so "none found" is never mistaken for "none have it". Searches are audited. Stored answers are kept as long as command results are (platform retention setting).
- **Load samples ride on the heartbeat** as an optional `health` object (processor use since the last heartbeat, memory in use, free space on the system drive, whole percents). The server stores at most one per cabinet every 15 minutes and keeps 14 days (under 1,400 rows a cabinet, about 150 MB for 1,000 cabinets and 1.2 GB for 8,000), enough for a week's trend. They come from plain Windows calls that need no rights. Older agents send none and the chart says so.
- **Last known state:** every reading on a cabinet's Windows tab shows the latest stored answer with when it was read, whether or not the cabinet is online; Run reads it again.
- **Peripherals by type of device** are placed in a class by plain words in the device's name (fingerprint scanner, network adapter, keyboard and mouse, touch screen, card reader, barcode scanner, storage, audio, camera, hub, other). Printers are not a class.

### Drive failure prediction, October 2026 (built, thresholds to tune on real drives)

The agent already checked each drive's own health report once a day (`disk.smart`: Windows' verdict, the drive's failure prediction, reallocated and pending sectors, uncorrectable errors, wear, heat) and raised an event for a drive in trouble. What was missing was **history**: a drive whose reallocated sectors go 0, 3, 11, 26 over a month looks the same, one day at a time, as one that has had 26 for years.

- **The agent sends each daily drive report once** with the next heartbeat (`health.drives`, up to 32 drives, the same fields as `disk.smart`). Nothing new runs on the cabinet and nothing needs administrator rights beyond what the daily check already used.
- **The server keeps one sample per drive every 12 hours for 400 days** and judges the history (`server/src/services/trends.ts`, plain arithmetic, tested with plain numbers). Levels: *ok*, *watch* (look at it), *act* (plan a replacement), *urgent* (back up and replace now).

| What the history shows | Level |
|---|---|
| The drive predicts failure, or Windows says it is failing | urgent |
| Uncorrectable errors or pending sectors above zero | act; urgent when the number grew in the last 30 days |
| Reallocated sectors above zero and steady | watch |
| Reallocated sectors that grew in the last 7 days | act |
| 8 or more new reallocated sectors in 30 days | urgent |
| Wear 80%, 90%, 95% or more | watch, act, urgent |
| Wear rising so that 100% is reached within 180 days, or 60 days (needs 4 reports over at least 14 days) | act, urgent |
| 60 °C, 70 °C or more; or 10 °C hotter than 30 days ago | watch, act, watch |
| Windows health "warning" | watch |

- **Alerts:** a drive reaching *act* raises a minor "Drive failing" alert, *urgent* a major one, once and only when its level rises. *Watch* raises nothing; it shows on the cabinet's drive page and in the Fleet page's "Drives to look at" list, which appears only when a drive is a concern.
- **Free space is forecast too:** the system drive's free percentage over the last 14 days (at least 48 samples over 5 days) is projected forward; a drive that would be full within 30 days raises a "Low disk space" alert (major within 7 days).
- **The thresholds are first estimates.** SMART attributes differ by maker and by interface (NVMe reports wear and spare capacity; SATA reports reallocated sectors), and Windows exposes only some of them. They should be reviewed against real cabinets' drives after a few weeks of data; every rule is a constant in one file.

## Database engine changed to SQL Server (October 2026)

Decided by the owner: the platform database is Microsoft SQL Server 2022, because the owner's teams already run SQL Server and its management tools. The first milestones had used PostgreSQL; nothing was ever deployed on it, so there is no data to migrate and the schema is one consolidated baseline (`server/migrations/0001_baseline.sql`). How the code talks to it, and what differs on purpose, is in `docs/platform/sqlserver-port.md`.

Open: the edition (Express is free to 10 GB and fits a small deployment; Standard or Enterprise for more or for high availability), and backups for a managed deployment (the compose kit documents a BACKUP DATABASE routine; a production install should use the owner's existing backup tooling).

## Agent communication cadence (October 2026)

The owner asked for the cheapest communication that still delivers commands within seconds and detects offline cabinets within about 5 minutes. Protocol 1.1 (03-protocol.md) keeps the 25-second long poll as presence and NAT keepalive, moves the heartbeat to every 5 minutes by default (server-directed), and adds leased delivery, durable results, admission control and paced catch-up. Still open:

- **Outbound proxies.** Some clinics may require one. Proposal: an explicit proxy setting in the agent's configuration (HTTP CONNECT only, no automatic discovery), with mutual TLS end to end through the tunnel. Not built until a clinic needs it.
- **A cabinet clock that is far off** (a dead CMOS battery) fails certificate validation, so the agent can never report it. Proposal: tolerate a not-yet-valid or expired server certificate only to send a time report, never commands. A security decision; not built.
- **Certificates of cabinets switched off for over 60 days** expire and need a new bootstrap token. The server now raises an alert a week before an unrenewed certificate expires.
- **The poll's `ack` query string has no contract schema yet.** The server checks it strictly in code (only `ack`, at most 50 GUIDs, comma-separated, anything else 400). Proposal: add `envelopes/commands-request.schema.json` to the contracts so the agent and server share it.
- **Pacing is set in the settings table only** (`agents.heartbeatSeconds` 60–900, default 300; `agents.pollSeconds` 15–110, default 25; `agents.eventsPaceMs` 0–60000, default 2000). The console's settings contract has no fields for them yet. Under load the server raises the events pace (×4, at least 10 s).
- **A re-offered command answered "replayed"** by an agent without a stored result is taken as the acknowledgement, not the outcome; the command then expires as unanswered unless the real result arrives.
- **A command acknowledged but not yet stored** is lost if the agent process crashes in between (it is not offered again because it was acknowledged); it expires on the server and the console shows it as expired. Proposal if this matters in practice: acknowledge only once the command is in the agent's durable queue.

## Database at 10,000 cabinets on SQL Server Express (October 2026)

Built to fit one 4 vCPU / 8 GB machine with SQL Server Express (1.4 GB buffer pool, 10 GB per database); sizes in [performance](../platform/performance.md) "Database size". Differences from the spec, and questions for the owner:

- **Events are kept 90 days (the owner's decision, October 2026), with the bulky JSON cleared after 30 days for events that have no alert.** Whole, 90 days of events would be about 7.7 GB of the 10 GB an Express database may hold; with the clearing it is 4.8 GB and the database about 9.2 GB in the first year at 10,000 cabinets (docs/platform/performance.md "Events: 90 days within 10 GB"). That fits Express only barely and not in year two. *Open for the owner: command answers 30 days instead of 90 (-1.4 GB), clearing after 14 days instead of 30 (-0.5 GB), or SQL Server Standard.* The cleared events keep their kind, times, cabinet and device; detail and source are gone, so an old unalerted event cannot show its message. Alerted, security and crash events stay whole.
- **Load samples older than 48 hours are kept as one row per hour** (minimum, average, maximum) for the rest of the 14 days; the trend chart shows hourly points before that.
- **Offline and site-outage alerts wait after the server or its database was away** (or when fleet-wide contact falls by more than half, or no heartbeat arrives for 3 minutes) until the offline window plus the agents' 5-minute backoff has passed. The fleet-wide signals count only with at least 20 cabinets reporting, so small installations behave as before. A real regional outage of more than half the fleet is therefore reported up to an hour late (until the remembered "usual contact" ages out). *Owner to confirm.*
- **The audit log is never pruned**, and grows by about 1.7 GB a year at the assumed support activity: it reaches Express's 10 GB in roughly three years. *Open: archive older years to signed files (the chain checkpoint makes that verifiable), or move to SQL Server Standard.*
- **Command results** are the largest table after events and are not compressed by SQL Server (page compression skips varchar(max) values). Keeping them 30 days instead of 90 would save about 1.4 GB at the assumed volume. *Open.*

## Operations telemetry and alerts (October 2026)

Decided by the owner: no email features of any kind. The platform counts its own health (docs/platform/operations.md) and raises operations alerts through the security alert mechanism; nothing is sent out. Choices made where the spec was silent:

- **The database account cannot see `sys.master_files`, msdb or volume statistics by default**, so the size guard reads `sys.database_files`, and free disk and backup age show "unknown" (and raise nothing) until the host admin grants `VIEW SERVER PERFORMANCE STATE` (2022) and `SELECT ON msdb.dbo.backupset` to the application's login. *Owner to decide whether the compose kit should grant them.*
- **Thresholds**: database 70% and 85% of the Express limit (no alert on editions without one); free disk below 10% or 5 GB; no backup within 36 hours (or none recorded when msdb is readable); certificate authority within 60 days of expiry; 5xx spike = 20 or more server errors and 2% of requests over 5 minutes; shedding = more than 5% of requests turned away in each of 10 minutes (minutes with under 20 requests do not count). All are constants in `ops-health.ts` and `ops-meter.ts`.
- **Size, disk, backup and CA alerts close themselves** when the condition is gone (audited as `security_alert.auto_resolve`); error and shed alerts stay open until an Admin closes them.
- **Agent faults are reported as codes** in `agent_status` events (`check` and `code` fields, e.g. `loop_restart` / `heartbeat`, `renewal_failed` / `http_503`), at most once an hour per code. Update failures were already reported by the upgrade status; event-queue losses already existed.
- **Pacing settings** (heartbeat, poll length, event pace) are editable in Admin -> Settings; values read from the table outside the ranges are clamped, no longer replaced by the defaults.

## Troubleshooting workflow (October 2026)

Decided while building it, for the owner to confirm:

- **Runbook approval needs an authenticator code, as rules do.** A runbook cannot run anything by itself, but it tells a Tier 1 person which button to press, so an Admin decides. An Admin who writes one still approves it in a second step.
- **Only changes confirmed by a click can be a runbook fix.** Changes that need an authenticator code (network addresses, restarts, package installs) stay on the cabinet's own pages. The firewall policy is filled in by the server, so a runbook sends it no parameters.
- **Error trends count days as the UTC date the platform received the events**, and "cabinets" as the busiest day's count, because distinct cabinets over several days would need a scan of the events table at request time or a nightly scan of 30 days. Today's partial day is not shown. The nightly job reads one finished day through the `events_received_at` index. If exact seven-day distinct counts matter, a second nightly pass over seven days is the way.
- **Case notes keep their text out of the audit log** (free text can hold anything); the audit log records that a note was added, its length and what it hangs on. Redaction by an Admin needs a reason and keeps the note.
- **Diagnose this cabinet refuses an offline cabinet** instead of waiting for the reads to expire. The network diagnosis alone still waits.
- **Open question:** should the triage queue also include the latest cabinet diagnoses' findings (for example "wrong gateway on 5 cabinets") as groups? Today its groups are alerts by issue type and unrecognized errors; the batch network diagnosis already groups fixes by cause.
- **Open question:** the connection profile read, per-server DNS resolution and a per-hop traceroute are agent operations still to be written (Windows code, not testable on the Linux build machine).

## Windows coverage (October 2026)

- **Built (not yet run on a real cabinet):** `system.hardware`, `system.identity` and `network.hosts`, read-only Tier 1 reads (see 04-agent-spec.md). `docs/platform/windows-coverage-review.md` keeps the remaining ideas (update source and service health, volume integrity).
- **To confirm on a real cabinet:** the registry values that hold the last Group Policy time (`...\Group Policy\State\Machine\Extension-List\{00000000-0000-0000-0000-000000000000}`, `EndTimeLo` and `EndTimeHi`; the reading is null when they are absent), the display list from `root\wmi` `WmiMonitorID` in the services session, and TPM `enabled` from `Win32_Tpm` (needs the broker's rights). `system.identity` runs in the network process (no administrator rights needed; the domain controller lookup is a network call, which the broker never makes) and reads only the automatic sign-in flag and user name, never the password.
- **Decision:** fleet search reaches the three new readings by plain text (model, manufacturer, BIOS version, processor; domain, workgroup or local administrator name; hosts name or address) and, for identity, by the keywords `workgroup`, `auto_logon` and `no_domain_controller`. No new alert rules: a hosts line or a workgroup cabinet is shown, not raised.

- **Scanner IDs need no authenticator code (kept, reviewed).** A review pointed out that setting the fingerprint scanner IDs at fleet, client, site or cabinet level takes an optional step-up token. This is deliberate: it changes only which device the scanner checks look at, nothing on a cabinet; it is role-limited (Admin for the fleet, Tier 2 below) and audited. A token that is supplied is still verified. Say if the fleet-wide setting should require a code.

## Baselines and configuration snapshots (October 2026)

Built as phases 1 and 2 of the earlier design (see 15-baselines-and-config.md). Choices made where the spec was silent, for the owner to confirm:

- **Eleven categories**, including the `hosts`, `tasks` and `system` reads that exist since the Windows coverage work. Startup commands are reduced to the program (arguments can hold secrets). No registry value or scheduled-task action text is collected beyond these readers.
- **Who approves**: Tier 2 writes, an Admin approves with an authenticator code and a written reason; an Admin cannot approve their own proposal while another active Admin exists. *Say if a single Admin site should need a second person some other way.*
- **A baseline that is not approved is never compared with**, and a cabinet with no approved baseline is `unknown`, never `healthy`.
- **Capture leaves out per-cabinet values** (addresses, MAC addresses, interface indexes, update dates, the devices category) for scopes wider than one cabinet, and service state and link state always.
- **Retention**: change rows and health transitions follow the events retention setting; versions are kept 20 per category (plus any a healthy mark points at); healthy marks 30 days plus the newest 10.
- **Cabinet model** comes from Windows (`system.hardware`); an Admin override (a `model_override`) is **not built**. *Open question: is it needed, or is the model read from Windows always right?*
- **Quota**: 240 configuration uploads an hour per cabinet (a setting in the agent API options).
- **Windows code not run on a real cabinet**: the config collector and its registry, WMI and `pnputil` readers have mocked tests only. Run `config.snapshot` on a real cabinet and check each category before relying on it.
- **Not built (later phases)**: incidents and correlation, playbooks, restoring a difference, fleet recovery, an offline cache, registry values, scheduled-task allowlist, driver and update rollback, service start type changes.

## Serving the console under a path (October 2026)

Built so the console can sit on a shared domain at a path (for a demo front, say) instead of the root of its own origin:

- **`CONSOLE_BASE`** (a build argument of `deploy/Dockerfile`, `/` by default) is passed to Vite as `--base`, so every asset URL is built under the prefix; `console/src/lib/base.ts` applies the same prefix to the console's own addresses: routes, links, API calls, the live stream and the "we are signed out" return. The router still matches plain app paths, so no page or step has to know about the prefix. Tests: `console/test/base.test.ts`.
- **Chosen because the router compares absolute paths**: a proxy that mounts the console under `/console` cannot work while the console believes it is at `/`, and the alternative (proxying every one of the console's page paths at a domain root) breaks silently whenever a page is added.
- **The root deployment is unchanged**: with the default base the helpers are no-ops.
- **Open question:** `CONSOLE_ORIGIN` accepts exactly one origin, so a console reachable by two addresses can only be signed in from the pinned one. Say if it should accept a list.

## Open alerts of a removed cabinet (October 2026)

Removing a cabinet revokes its certificate (02-security-model.md) and takes it out of every fleet view — the client, site, offline, differences and fleet-operations queries all require `status = 'active'`. The spec says nothing about the alerts it had already raised, and they stay open. The console's alerts area therefore still lists them against a cabinet that no longer exists, and each row links to that cabinet's page, which `fleet.cabinet` serves without a status check (so a removed cabinet's page still renders).

- **Recommended, not built:** when a cabinet is removed, resolve its open alerts with a system-actor audit entry and a reason, so no fleet view can show a cabinet that is gone.
- **Also say if** a removed cabinet's alert history should stay readable somewhere (an archive or a filter that shows retired cabinets on purpose), or whether resolving them is enough.
- Found because two retired test cabinets (PetFolk / Scottsdale: `Exam Room (removed 2026-10-22)` and `Enrollment Test`) left twelve open alerts behind after their enrollment tests.

## Approved applications: who approves, and what an empty list means (October 2026)

The control half of milestone 10 (`docs/spec/13-roadmap.md`: `process.end` and `app.restart` "with a per-client allowlist") needs a list of exact programs per scope. `contracts/schemas/console/approved-apps.schema.json`, migration `0006_approved_apps.sql` and `server/src/services/approved-apps.ts` build it as a scope setting beside the watched services and the file-facts paths: one JSON column per level, the fleet default as one settings row, the most specific level with a list winning whole.

- **Server administrators only**, not Tier 2 and up, although the spec's milestone 10 wording is "an admin". Everywhere else, changing a client's, site's or cabinet's own list is a Tier 2 action with a confirmation click; the fleet default is Admin only. A program the platform may start, stop or restart is an owner's decision, and the list is the thing a lost Tier 2 session would most want to widen. Say if a Tier 2 account should be able to propose a list that an Admin approves.
- **An empty list is a level of its own**: it approves nothing at that level and still wins over the level above. `entries null` instead removes the level's list, so the level above applies. The spec does not distinguish the two, and the console's editor needs to show them differently.
- **A request will name the entry's key** (`app:<name>`), never a raw PID, a service name alone or a command line. A PID may point at the thing (to read its image path) but cannot be the stored identity, because Windows reuses PID numbers.
- **Built, not yet enforced end to end:** the list is stored, resolved and audited; pushing it to the cabinet, the broker refusing anything not on its own copy, and the console page that edits it are the next slice.

### The cabinet's own copy is now the gate, and what about it is deliberate (October 2026)

The list reaches the cabinet on the heartbeat and the cabinet now refuses before Windows is asked: `agent/src/Cabinet.Agent.Core/Services/ApprovedApps.cs` re-validates every entry it is sent, `ServiceRules` re-reads the service's registered program on each request, and `ApprovedProcessEnd` reads the program running under a process ID inside the broker — the process that holds the administrator rights. It arrives through the settings file the network service already writes, which the broker re-reads when its length or write time changes, so a console change takes effect without restarting the broker and no new pipe carries it.

- **The watcher acts on the watched list only for approved services (changed 2026-10-25, owner: setup must be secure).** `ServiceWatcher` now asks the same approved-list check as service.control before it starts a watched service. A watched service that is not approved (or whose registered program no longer matches its entry) is reported with the existing `refused` watch state and is never started; watching a service is no longer a way round the list. No new contract value was added: the console shows it as "Never touched by the agent". Say if it should get its own state and alert (a contract change).
- **service.setStartType asks the list when the change would let a service start (2026-10-25).** Automatic, automatic (delayed), and lifting Disabled to Manual need the service on the approved list, the same check as a start; lowering a start type (to Manual or Disabled) starts nothing and needs no entry.
- **An application is pinned by its path, not by its publisher.** The entry has no field for a signing certificate, so a program whose file is replaced at the same path still matches. An optional publisher thumbprint, checked with `X509Certificate.CreateFromSignedFile`, is the next step if that gap matters; it also has to answer for the in-house programs nobody signed.
- **A settings file that is missing, oversized, corrupt or contract-invalid approves NOTHING (changed 2026-10-25).** The broker used to keep the last good list; it now fails closed, because a list it cannot read now is not one it can vouch for. The file's size is checked before it is read (256 KB cap). A cabinet whose file is damaged stops starting, stopping and ending approved programs until the next heartbeat answer rewrites it.


## Deployment: generic main, local overrides (October 2026)

Main carried one machine's deployment (a tailnet front, Tailscale Funnel, a console origin on a personal domain, the server's public IP and tailnet names, and unsigned development upgrades switched on). Decided with the owner:

- **Main is generic.** `deploy/compose.yaml` publishes the console (Caddy, 80 and 443) and the agent API (8443) on every interface, takes every machine-specific value from `deploy/.env`, and builds with `ALLOW_UNSIGNED_DEVELOPMENT_UPGRADES=false` unless `.env` says otherwise.
- **The tailnet setup is local, used when needed.** `deploy/compose.override.yaml` and `deploy/Caddyfile.local` are git-ignored; `deploy/examples/tailnet/` documents them with placeholders.
- **Console and agent API public for the test period** (cabinets on separate networks must reach the agent API). The spec's Control 3 (console on an internal network or VPN) still applies before production: set `CONSOLE_ALLOW_FROM` or keep the console behind the tailnet.
- **Open:** confirm the release private key does not live on the server host. With unsigned development upgrades on, that key alone decides what every cabinet runs.

## Sign-in limits: one person cannot lock everyone at an address out (October 2026)

Control 6 limits sign-in "per account and per address". Behind a proxy that hid the browser's address, every person shared one address, so thirty wrong passwords from anyone refused every sign-in for 15 minutes.

**The real address reaches the server.**
- Caddy sends the server exactly one address, the one it determined (`header_up X-Forwarded-For {client_ip}`).
- The tailnet example trusts `X-Forwarded-For` only from the Docker gateway Tailscale connects through. Tailscale Serve and Funnel (HTTP mode) overwrite that header with the address that connected to them, so a browser cannot plant one.
- Two assumptions follow:
  - Serve or Funnel in raw TCP mode would make the header spoofable.
  - Trusting the gateway trusts every process on the host.

**The address limit no longer locks out people it cannot tell apart.**
- **What is counted:** an IPv4 address, an IPv6 /64 (30 failures in 15 minutes), and an IPv6 /48 (120).
- **Past the limit:** only a browser that has fully signed in to the account may still try. That means past the password and the authenticator code. It is recognised by its device cookie (256 random bits, stored as a hash, marked trusted by migration 0009's `trusted_at`).
  - A password alone never makes a browser trusted.
  - Changing the password keeps only the browser that changed it.
  - An Admin ending the account's sessions (password or authenticator reset, role change, deletion) forgets them all.
  - The browser's wrong passwords still count toward the account's own lock.
- **How it answers:** a request without a trusted browser is refused before the username is looked up or a password checked, at no database cost. The browser is looked up by its device value alone, so the answer costs the same for any username.
- **After the password:** the steps that follow (authenticator code, password change, password confirmation) need a session. The account's own lock guards them, not the address limit.

**Still open:**
- **One account can still be locked by name.** Five wrong passwords lock that account for 15 minutes, whatever the address. The spec's per-account lock is unchanged. A trusted browser does not get past it.
- **People behind another site's proxy share its addresses.** That covers, for example, a rewrite on another domain. They share an address limit until each has fully signed in once from their browser. Trusting that proxy's forwarded header would need a secret only the proxy can send.

## Installing the agent: one installer per cabinet (October 2026)

The Setup page makes `Install-CabinetAgent.cmd` for one cabinet. It carries the server address, the platform CA, both package hashes and a one-time token, picks the 32-bit or 64-bit package by asking Windows, and runs on the built-in Windows PowerShell 5.1. The pasted command block, `token.txt` and `platform-ca.pem` are gone from the page.

- **Unsigned builds are the build's statement, not a default.** The installer passes `-AllowUnsigned` only when the package folder holds the `UNSIGNED-DEVELOPMENT-BUILD` marker the Docker build writes, and never when `NODE_ENV=production`. A signing pipeline leaves the marker out.
- **Accepted residual risk.** The installer is double-clicked from a folder the operator's own account can write (Downloads, a USB stick). Code running as that same account, without elevation, could change the file between the double-click and the moment the elevated part reads it. UAC is not a boundary against same-user code, and no file run from a user-writable folder can close that. What the installer does close: once elevated it works only in a new folder that only SYSTEM and Administrators can change, and it hashes the copy it unpacks, so a package swapped after the check is never the one installed.
- **The token in the file.** Like the `token.txt` it replaces, it works once, expires in 7 days, and the cabinet still waits for an Admin's approval. The installer deletes itself after a successful install.
- **Uninstall** is left on the cabinet at `C:\Program Files\Mashura\Uninstall-CabinetAgent.ps1`, outside the program folder an upgrade replaces.

## Agent API: what certificate-less traffic can spend (October 2026)

The agent API is on the public internet. Traffic without a valid cabinet certificate now has its own limits and cannot shed enrolled cabinets. The details are in 03-protocol.md.

- **Defaults:**

  | Limit | Default |
  |---|---|
  | Certificate-less requests, per source | 5 per second (burst 50) |
  | Certificate-less requests, in total | 200 per second |
  | Enrollment and its status, in total (they reach the database) | 10 per second |
  | Enrollment submissions, per source | 60 per hour |
  | Enrollment status polls, per source | 60 per minute |
  | Open connections, per source | 256 |
  | Open connections, in total | 30,000 |
  | TLS handshake | must finish within 10 seconds |

  A site's cabinets usually share one public address. Thirty of them enrolling the same day are well inside these limits, and a refused attempt keeps its token and retries.
- **Two deployment caveats, not handled in code:**
  - **Behind a load balancer without PROXY protocol, every source shares one address.** The per-source limits then become one shared limit, which still never touches the enrolled fleet's buckets.
  - **With AGENT_API_WORKERS above 1, each process keeps its own buckets.** The effective limits are multiplied by the number of workers.
- **Not covered by this change: a valid cabinet certificate that multiplexes many HTTP/2 streams.** It still draws on the shared request bucket. That is an insider or stolen-certificate case, and a per-connection request limit is the follow-up.
- **Handshake floods large enough to saturate the CPU need a network-level limit**, such as the provider's firewall or a rate limit in front of port 8443.

### Open: the approved list on the cabinet is written by the network process (2026-10-25)

The cabinet's copy of the approved list lives in `state\monitor-settings.json`, which the network service writes from the heartbeat answer because the broker never touches the network. The network service can therefore write any list it likes: a network service that has been taken over can approve a program of its choice and then ask the broker to start, stop or end it. The list is a guard rail (it keeps an honest network service, a mistaken console request and a replayed command to what the console approved), not a wall against a compromised network process. The code comments and this file used to say the network process "cannot name a program the server's list does not carry"; that was not true and has been corrected.

The fix that would make it a wall: the server signs the list (or the whole heartbeat answer's list part) with an administrator-held key, and the broker pins that key the way it pins the upgrade keys (compiled in, changed only by a signed agent upgrade), refusing any list whose signature does not verify. Questions for the owner: which key signs it (a new KMS key, or the upgrade signing key's chain), whether the console's list change then needs an offline signing step, and what a cabinet does between an agent upgrade that adds the check and the first signed list (proposal: approve nothing).

## Approved programs: what counts as control, and what the server enforces (October 2026)

Decided with the owner: only programs on the approved list are watched or restarted. Changes made after an adversarial review:

- **Starting, stopping and starting at boot are all control.** `service.control`, `service.setStartType` and `process.end` need an approved target and an authenticator code bound to the parameters, whatever the catalog says. Lowering a start type is control too, since it stops the service at the next boot. That makes `service.setStartType` a code action for an approved service only. Runbooks can no longer offer it as a one-click fix, and existing runbook steps that use it are refused when run.
- **Watched services are filtered on the server.** A service on a watched list that the approved list does not name is never sent to the cabinet. Agents built before the watcher checked the list start whatever they are told to watch.
- **A damaged list is shown as damaged.** The heartbeat and the control check read the stored lists the same way: a damaged level denies everything and is never read as "not set". The console says so and lets an Admin replace it.
- **Process paths are compared without regard to case**, as Windows and the cabinet do.
- **The cabinet repairs its list file.** If the file is missing or damaged, the next heartbeat answer rewrites it, even when the server's list did not change.
- **Known and accepted:**
  - A service entry also allows ending its program's process. `svchost` and the platform's own processes stay protected by the agent's refused list.
  - An unquoted service image path with spaces is matched as written. Planting `C:\Program.exe` needs administrator rights.
  - The USB policy writes are now Admin-only and need a code, but no route calls them yet.
- **Signing the list:** decided on 2026-10-26; see "Signing the approved list" below.

## Signing the approved list (October 2026)

This answers "Open: the approved list on the cabinet is written by the network process" above. The owner chose to sign the list with an Admin key kept offline, knowing every list change then needs that key.

- **The key.** A P-256 key of its own, never the release key. `New-ApprovedListTrust.ps1` refuses a key the agent already trusts for releases. It is one of:
  - a key file protected by a passphrase, kept on removable media (`-NewKey`);
  - an AWS KMS key;
  - an Azure Key Vault key.

  The private key never reaches the server.
- **Where the cabinet gets the public key.** It is compiled into the agent from `contracts/trust/approved-list`, the way the release key is, so only a signed agent upgrade can change it.
  - An earlier plan had the installer write the key into a folder only administrators can change. That was dropped because the server makes the installer files: a server that had been taken over could put its own key into every new installer.
  - At most two keys are held, the current one and the next, so the key can be changed.
- **What is signed.** One level's list, as a small JSON document the server writes once when an Admin saves the list (`agent/approved-list.schema.json`).
  - The document holds `product: "mashura-approved-list"`, the level, the scope id, the version, the time, and the entries.
  - The signature covers those exact bytes (`agent/approved-list-signature.schema.json`).
  - Nobody re-serialises the document, so the bytes the Admin signed are the bytes the cabinet checks.
- **Checking it.** The server and the agent run the same check, held to the same vectors (`contracts/vectors/approved-list-vectors.json`):
  1. The signature, against a pinned key, before anything in the document is read.
  2. Then a strict parse. The agent refuses duplicate names.
  3. Then the contract.
- **The Admin's steps.**
  1. Save the list in the console, with a code, as now.
  2. Download it as a file.
  3. Run `Sign-ApprovedList.ps1` on it. The script prints every program the list approves and asks for `SIGN` to be typed.
  4. Upload the signature file.

  The script refuses a file that is not an approved list, and an entry that holds a control or text-direction character, since that could make the screen show something other than what is signed.
- **Until the signature is uploaded,** the level's previous signed list stays in force on the server and on the cabinets.
- **On the cabinet.**
  - An agent built with a list key acts only on a list whose signature verifies. An unsigned, damaged or wrongly signed list approves nothing.
  - An agent built with no list key works as it did before signing existed. The repository ships with no key, so nothing changes until the owner makes one and releases an agent built with it.
  - Between that release and the first signed list, those cabinets approve nothing. That was the proposal above.
- **Delivered in three pull requests, in this order:**
  1. The format, the checks on both sides, and the two scripts. Nothing uses them yet, so behaviour does not change.
  2. The server and console flow: waiting for a signature, download, upload. The heartbeat answer carries the signed document.
  3. The broker enforcing it on the cabinet.
- **Known limit, open.** The signature proves that an Admin approved the list for some level. It does not prove the list is the one for this cabinet.
  - A taken-over network service could hand the broker another list an Admin signed. Examples: the fleet list in place of a stricter site list, or an older version of the site's own list.
  - It can no longer approve a program no Admin approved anywhere, which is the attack this change closes.
  - Binding the list to the cabinet's own site needs the cabinet to hold its site from enrollment. That belongs with the enrollment change (site set at enrollment).

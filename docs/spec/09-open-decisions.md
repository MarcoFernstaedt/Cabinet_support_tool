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

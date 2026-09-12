# Data residency — an open question, not a solved one

This document exists to be read by somebody in legal or compliance before this
platform is deployed outside the country its server runs in. It does not
propose a residency design, because that decision is not an engineering one to
make. What it does is state precisely what crosses a border when a cabinet
checks in, so that the people who do make it are deciding about the real
payload rather than about a guess.

**Status: unresolved.** The platform is safe to run within one jurisdiction
today. Nothing here should be read as clearance for a multi-country
deployment.

## Why this is open

The fleet spans thirteen countries. Every cabinet sends its telemetry to one
server. That means routine, continuous transfer of data about machines in
clinics in one jurisdiction to a server in another, and that transfer is
regulated differently in each of them. Several of the regimes involved turn on
questions this document can inform but not answer:

- whether the payload contains personal data as the local regime defines it
- whether it contains health data, which is usually a separate and stricter
  category
- whether an employee's user name observed on a machine makes the transfer a
  transfer of employee personal data
- what a controlled-substance regulator expects of records about the systems
  that hold controlled substances, as distinct from records of the substances
  themselves

Engineering's part is the first two bullets' factual half, below.

## What the payload contains

Every field the agent collects is in `CabinetPlatform.Contracts.Telemetry`.
There is no free-form section and no channel through which an operator can add
one. The complete list, by section:

### System

Hostname, operating system version and build, install date, last boot time,
uptime, time zone, the machine's own clock reading, domain or workgroup name,
whether the machine is domain-joined, whether any interactive session is
logged on, how many are, and the list of installed software with versions and
publishers.

**The logged-on count is a count.** No user name, no session identifier, no
account. The reboot interlock needs to know whether somebody is there, not who.

**Installed software is a machine inventory.** It lists what is installed on
the cabinet PC, which on these machines is the dispensing client, the agent,
and ordinary Windows components.

### Performance

CPU utilisation overall and per core, memory installed, available and used,
page file size and use, the running process list, and the programs configured
to start at logon.

**The process list carries image names and process identifiers.** It does not
carry command lines, window titles, or the account a process runs as. It is
collected on request only — never on a routine check-in — so it exists on the
server for the cabinets somebody has actively looked at and no others.

**Startup programs carry the command line Windows recorded for the entry.**
This is the one place a path or a command string appears anywhere in the
platform. It is inbound observation: it is displayed to support staff and is
never executed, echoed to an agent, or accepted as input. A test asserts that
nothing on the action path can reach it.

### Services

For each Windows service: its name, display name, run state, configured start
type, the account name it is configured to run as, and its process id.

**The run-as account is a service account name** — `LocalSystem`,
`NetworkService`, or a named service account — not a person's account.

### Disks

Per volume: drive letter, label, file system, capacity, free space, BitLocker
state, and queue and throughput counters. Per physical drive: model, serial
number, and the SMART counters.

**A drive serial number identifies a component, not a person.**

### Event logs

Selected records from the Application, System and Security logs: log name,
source, event id, level, timestamp, and message text.

**This is the section with the most exposure, and it is the one that is
collected on request only.** It never travels on a routine check-in. A Windows
Security log records logon events, and those records contain account names;
so an event log window fetched for a cabinet can contain the user names of
people who signed in to that machine. That is a deliberate limitation of the
collection, not of the storage: the records are stored against the action that
fetched them, so it is always answerable who asked for them and when.

### Windows Update

Pending update identifiers and titles, install history with result codes,
reboot-pending state, the configured active hours, and the deferral policy.

### Network

Per adapter: name, description, MAC address, link state and speed, IP
addresses, subnet masks, gateways and DNS servers, and whether DHCP is in use.
Plus the firewall profile states, any configured proxy address, and whether the
cabinet could reach this server and how quickly.

**IP and MAC addresses are treated as personal data under some regimes** even
when they identify a fixed clinic machine. This is the second section worth a
lawyer's attention.

## What the payload does not contain

Stated as plainly as the list above, because the absences are the point.

- **No patient data.** No patient name, identifier, record, or any field
  derived from one. The agent has no access to the dispensing application's
  data and no code path that reads it.
- **No dispensing records.** Nothing about what was dispensed, to whom, by
  whom, when, or in what quantity. The platform monitors the machine the
  dispensing software runs on, not the dispensing.
- **No biometric data.** No fingerprint template, no facial data, no biometric
  identifier of any kind, in any form, anywhere in the agent, the contract, the
  server or the console.
- **No clinical data of any kind.**
- **No screen contents, keystrokes, or input.** There is no screen capture and
  no input monitoring.
- **No file contents.** The agent reads file system metadata — free space,
  volume layout — and never file contents. The diagnostic bundle collects the
  agent's own rolling logs and one check-in snapshot, nothing else.
- **No credentials.** No password, hash, token, key or connection string is
  collected, logged, or written to the audit trail. A test asserts that a
  failed login's audit record does not echo the attempted password.

## Where it goes and how long it stays

| Tier | Cadence | Retention |
|---|---|---|
| Heartbeat | every 5 minutes | 7 days at full resolution, then hourly aggregates for 90 days |
| Inventory | every 6 hours, stored only on change | kept as a change history, capped per cabinet |
| SMART | every 6 hours, always stored | 2 years, daily-aggregated after 90 days |
| Event logs | on request only | stored against the action that fetched them |
| Process list | on request only | stored against the action that fetched them |
| Audit | on every event | never aggregated, never deleted |

The audit trail is append-only by design and has no delete path. That is a
deliberate compliance property and it is also a residency consideration in its
own right: a regime with a deletion right and an audit trail that cannot delete
are in tension, and that tension needs resolving before, not after, a
deployment.

## What engineering needs back

1. Whether the payload as described constitutes personal data in each target
   jurisdiction, with the network addresses and the event log records
   considered separately from the rest.
2. Whether a per-country or per-region server deployment is required, or
   whether one server with a documented transfer basis is acceptable.
3. How the append-only audit trail is to be reconciled with any applicable
   erasure right.
4. Whether the on-request sections — event logs in particular — need a
   jurisdiction-specific restriction beyond the approval and audit they already
   carry.

Until those have answers, this platform should run within one jurisdiction.

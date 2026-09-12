# Check-in tiers and retention

Seven thousand cabinets checking in every five minutes is about two million
samples a day. A payload document per sample reaches terabytes within weeks,
and essentially none of it is ever read: every list and aggregate this server
serves reads a handful of typed columns.

So a check-in is not one thing. The `CheckInPayload` contract is unchanged and
carries every section — what varies is which sections the agent populates and
what the server persists.

## The tiers

| Tier | Route | Cadence | What the agent sends | What the server stores |
|---|---|---|---|---|
| Heartbeat | `POST /api/agent/checkin` | every 5 min | system, performance counters, disk free space, update counts | one `Heartbeats` row of typed columns. No JSON document. |
| Full | `POST /api/agent/checkin/full` | every 6 h, and on change | everything above plus services, network, disks with SMART, installed software, startup programs | a `Heartbeats` row, one `SmartReadings` row per drive, and an `InventoryVersions` row **only if the inventory content hash changed** |
| Event logs | action `CollectEventLogs` | on request | a window of Windows event records | against the action request that fetched them |
| Process list | action `CollectProcessList` | on request | the running process list | against the action request that fetched them |

The tier travels on the route, never in the payload. A payload cannot assert
which tier it is, so an agent cannot cause the server to store more than the
route it called permits.

`SectionErrors` applies per tier. A collector that fails on a heartbeat
records its reason on that heartbeat; one that fails on a full check-in
records it on that inventory version. A partial payload always explains its
own gaps.

## Why inventory is a change history

The agent sends inventory every six hours. The server hashes the content and
writes nothing when the hash matches the version already in force — it updates
one timestamp. A cabinet nobody touches for a year holds one inventory row,
not fourteen hundred.

The hash is taken over a deliberately narrower projection than what is stored.
Uptime, free space, CPU utilisation and a service's process id all change
constantly and none of them is a change of inventory; hashing them would make
every six-hourly check-in a new version and defeat the whole tier. What is
hashed is configuration: the OS and its build, the time zone, domain
membership, installed software, each service's name and configured start type
and run-as account, the firewall and proxy settings, each adapter's addressing,
each volume's capacity and BitLocker state, the update policy and the pending
set, installed memory, and what the machine launches at logon.

What is *stored* is the whole section, so a support engineer opening a cabinet
sees everything the agent collected — not the subset that determined whether
to store it.

## Why SMART is never skipped

SMART readings are stored on every full check-in, identical to the previous
one or not. This is the failure-prediction time series the platform exists to
produce, and a gap in it is a gap in the prediction. A drive whose counters did
not move for six hours is evidence; an absent row is not.

Each reading records which WMI source produced it — `StorageReliabilityCounter`,
`FailurePredictStatus`, or `FailurePredictData` — because a documented
reliability counter and a value decoded out of a vendor-specific byte array are
not the same measurement even when they carry the same name. A drive no source
answered for produces no row at all, which is what makes its health `Unknown`
rather than `Healthy`.

## Retention

| Data | Full resolution | Then | Finally |
|---|---|---|---|
| Heartbeats | 7 days | folded into one row per cabinet per hour, kept 90 days | deleted |
| Inventory versions | kept as a change history, never aged out by time | capped per cabinet, oldest first, current version never removed | — |
| SMART readings | 90 days | folded into one row per drive per day, kept 2 years | deleted |
| Audit entries | forever | never aggregated | never deleted |

`AuditEntry` appears nowhere in the retention service. That is checked by a
test, not by convention.

### Aggregation keeps the worst value, never the mean

An hour in which a cabinet spent five minutes at ninety-eight percent memory
and fifty-five minutes idle had a problem. An average erases exactly the
evidence somebody would go looking for. So an hourly heartbeat aggregate holds
the maximum CPU, the maximum memory, the minimum free disk, and the worst disk
health seen in the hour — and a daily SMART aggregate holds the day's worst
value for every counter.

A counter that was null throughout stays null. An hour with no reading
aggregates to no reading, never to zero.

The logged-on flag is folded more conservatively still: any `true` wins, and an
unknown beats a `false`. Folding an hour that contained one unreadable sample
down to "nobody was logged on" would turn a missing reading into permission to
reboot, which is the failure this codebase is arranged throughout to prevent.

## Both database providers

The model is identical on SQLite and PostgreSQL and every query is LINQ with no
provider-specific SQL. There is one migration set per provider, because EF Core
generates migrations against a concrete provider and column types differ; each
is scaffolded from its own context subclass and lives in its own namespace.

SQLite is the local development and test database. It is not the deployment
target: at seven thousand cabinets the heartbeat and SMART tables reach volumes
it cannot serve, and its single-writer lock is the wrong shape for twenty
concurrent support reps besides. **PostgreSQL is required before any
multi-site deployment.**

One provider difference is worth knowing about. SQLite has no date type, and
its EF provider refuses to translate `<`, `<=`, `>` and `>=` on a
`DateTimeOffset` — a runtime exception, not a compile error. Every range query
in this server is over a timestamp, so the SQLite context maps
`DateTimeOffset` to fixed-width UTC text, which sorts chronologically as a
string. That is provider configuration, not a provider-specific query.
PostgreSQL has a real `timestamptz` and needs none of it.

Heartbeats and SMART readings are indexed on `(CabinetId, ReceivedUtc)` and
`(CabinetId, TimestampUtc)` respectively, both descending, with the
time-based partitioning those tables will need on PostgreSQL in mind.

### Running against PostgreSQL

```
Database__Provider=PostgreSql
ConnectionStrings__SupportDatabase=Host=…;Database=cabinetplatform;Username=…;Password=…
```

An unrecognised provider is a startup failure, not a silent fallback to the
development database.

Each provider's migrations are maintained through its own design-time factory,
so `dotnet ef … --context PostgresSupportDbContext` works without a running
server. Both sets have been verified in sync with the model, and the server has
been run end to end against PostgreSQL: migrations applied, fifteen tables
created, a login served, and an unauthenticated request refused.

## What the server tells the agent

A check-in response carries the cabinet identity the server issued, whether the
sample was a duplicate, whether the inventory was unchanged, how long to wait
before the next heartbeat and the next full check-in, and whether actions are
waiting. The intervals come from the server so that a fleet's cadence can be
changed centrally rather than by reconfiguring seven thousand agents.

The agent jitters its own interval around whatever it is told. Without jitter,
cabinets that came back together after a site outage check in together forever
afterwards.

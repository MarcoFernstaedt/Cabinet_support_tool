# Performance and capacity

How fast the platform answers, how many cabinets one server carries, how it was measured, and how to measure it again.
The spec asks for "a load test of the agent API with 8,000 simulated agents polling before going wide"
([build plan](../spec/08-build-plan.md), "Testing to keep throughout").

## What a cabinet does, and what that costs the server

Each cabinet's agent makes these calls (see [protocol](../spec/03-protocol.md) "Timing and limits"):

| Call | How often | Server work per call |
|---|---|---|
| `GET /agent/v1/commands` (long poll) | continuously; held up to 25 s | 1 query when it arrives; 1 more only if a command for that cabinet is announced |
| `POST /agent/v1/heartbeat` | every 60 s | 2 queries: record it (and learn if the cabinet had been offline), read its scanner settings. Offline alerts are looked at only after an outage, and the rollout check only while a rollout runs. |
| `POST /agent/v1/events` | when its monitors find something; up to 100 events per batch | store plus the alerts engine, in one transaction |
| `POST /agent/v1/results` | once per command | store and validate the result, in one transaction |

At 8,000 cabinets that is about 133 heartbeats a second and 320 polls a second, with 8,000 polls held open at any moment.

## The command round trip

When a person runs a diagnostic in the console:
1. The server queues the command.
2. A database trigger announces it (`NOTIFY`), and the one listening connection wakes that cabinet's held poll.
3. The poll takes the command in one statement and answers at once.
4. The agent validates and runs it, then posts the result. The console gets the result over its live stream.

So delivery does not wait for the next poll. A poll that has been held for 20 seconds returns within milliseconds of the command being queued. If the announcement listener loses its connection, held polls fall back to checking the database every 5 seconds until it is back, so a command is never stuck for a whole poll.

How long the operation itself takes on the cabinet depends on the operation: a `system.info` takes well under a second, and an event-log query depends on the log's size. The table below measures only the platform's part, from issue to the cabinet holding the command.

## Measured results

**Setup:** one 4-core, 15 GB Linux machine, shared by the server (one Node.js process), PostgreSQL 16 and the load generator. This is less than production will have, since the load generator competes for the same CPU.

**Workload:**
- 8,000 simulated agents, each with its own cabinet and its own client certificate. They ramped up over 120 s and then ran for 10 minutes.
- Each held the long poll and sent a heartbeat every 60 s.
- On average each sent 6 event batches an hour, which run the real alerts engine.
- A command source issued 2 `system.info` commands a second to random cabinets through the real issuing path, and each cabinet answered with a valid result.

### Final run (after the changes below)

| | Count | p50 | p95 | p99 | Max |
|---|---|---|---|---|---|
| **Command delivery, issue to cabinet** | 890 | **7 ms** | **13 ms** | — | 140 ms |
| Heartbeat | 76,017 | 4.5 ms | 18 ms | 77 ms | 404 ms |
| Event batch | 7,477 | 5.8 ms | 18 ms | 59 ms | 244 ms |
| Command result upload | 890 | 4.9 ms | 11 ms | 26 ms | 68 ms |
| Long poll with no command (should be 25 s) | 177,083 | 25.002 s | 25.012 s | 25.045 s | 25.318 s |

- 261,467 requests, **0 failed**; every command delivered.
- The server process used about half of one CPU core and 1.4 GB of memory at full load.

### First run (before the changes), for comparison

| | p50 | p95 | p99 |
|---|---|---|---|
| Command delivery | 198 ms | 1,168 ms | — (max 2,700 ms) |
| Heartbeat | 1,418 ms | 13,167 ms | 20,260 ms |
| Event batch | 443 ms | 3,412 ms | 7,328 ms |
| Long poll with no command | 25.6 s | 29.0 s | 30.8 s |

Nothing failed, but heartbeats waited up to 20 s. Every held poll re-checked the database every 5 seconds, which is about 1,600 transactions a second at 8,000 agents, and each heartbeat made five or six round trips. The changes that fixed it:
- A poll checks the database only when it arrives and when a command for its cabinet is announced. A wake counter, read before the check, closes the gap between the check and the wait.
- Taking queued commands is one statement, not a four-round-trip transaction.
- A heartbeat records itself and learns whether the cabinet had been offline in one statement, and reads the scanner settings in one query. It skips the rollout transaction unless a rollout is running (checked at most every 5 s per server process).
- The agent API no longer logs each request; refusals and errors are still logged, and everything that matters is in the audit log.

## Measured again, October 2026 (the platform as it is now)

The earlier results above were measured before load samples, drive history, stored readings, fleet search and the new actions were added. The load tool now sends what a current agent sends (a load sample with every heartbeat, and a drive report once), and the run was repeated on a deliberately small server.

**Setup:** the application server pinned to **2 cores** with a **1 GB** JavaScript heap limit (about what a 2 vCPU, 4 GB virtual machine gives it), PostgreSQL 16 on the same machine, and the load generator on the other two cores. 8,000 simulated agents, each with its own certificate, ramping up over 120 s and then running for 7 minutes (6 event batches an hour each, 2 commands a second).

| | Count | p50 | p95 | p99 | Max |
|---|---|---|---|---|---|
| Heartbeat (with a load sample; the first also carries a drive report) | 52,004 | 5.7 ms | 33 ms | 216 ms | 1.3 s |
| Event batch | 5,215 | 5.6 ms | 17 ms | 95 ms | 398 ms |
| Command result upload | 534 | 4.5 ms | 10 ms | 19 ms | 113 ms |
| **Command delivery, issue to cabinet** | 534 | **6 ms** | **14 ms** | | 192 ms |
| Long poll with no command (should be 25 s) | 119,579 | 25.002 s | 25.016 s | 25.094 s | 25.6 s |

177,332 requests, **0 failed**, every command delivered. After the ramp, heartbeats settled at p95 10 to 15 ms.
Server process memory peaked at **1.4 GB** (the 8,000 held connections are most of it); average CPU was about **40% of one core**.

**The ramp matters.** An earlier attempt that connected all 8,000 agents in 90 s (89 new connections a second, each a TLS handshake with a client certificate checked) missed the heartbeat threshold during the ramp (p95 1.7 s over the whole run) and was perfectly steady afterwards. At 120 s (67 a second) it passes. After a server restart the agents reconnect with a randomised backoff, so a real restart looks like the 120 s ramp, not a 90 s one. If that ever becomes a concern, run two server processes behind the load balancer.

### What size of server for how many cabinets

| Cabinets | Server memory (process) | Application cores | Database size after 14 days of load samples + a year of drive history |
|---|---|---|---|
| 100 | about 170 MB (estimated) | 1 | under 50 MB |
| 1,000 | about 290 MB (measured) | 1 | about 200 MB (estimated) |
| 8,000 | about 1.4 GB (measured) | 2 | about 1.5 GB (estimated) |

A **2 vCPU, 4 GB** virtual machine running the application and PostgreSQL together carries 8,000 cabinets as measured above, with room left over; 1,000 cabinets fit in 2 GB. Memory grows with the cabinets because each holds a connection open. PostgreSQL settings for such a machine: `shared_buffers` 1 GB, `effective_cache_size` 2 GB, `max_connections` 50 (the application keeps a small pool), and autovacuum left on, because load samples are deleted by the nightly retention job.

### What grows, and what keeps it small

- **Load samples:** one per cabinet every 15 minutes, rolled up to one row per hour after 48 hours, 14 days kept: under 600 rows a cabinet (about 35 bytes each). See "Database size" below.
- **Drive reports:** one per drive every 12 hours at most, 400 days kept: about 800 rows a drive, in the order of 100 KB.
- **Events, alerts, firewall history, diagnoses, boots, fleet jobs and command results** are pruned by the retention settings (Admin → Settings). The audit log is never pruned.
- **Fleet search** scans stored readings with a time limit of 15 seconds and one search at a time per person.

## Database size

Target: 10,000 cabinets in one SQL Server **Express** database (10 GB at most, 1.4 GB buffer pool), comfortably under 6 to 7 GB in the first year.

### What changed (the "data diet", `server/migrations/0001_baseline.sql`)

- **JSON columns are `varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8`**, not `nvarchar(max)`: UTF-8 stores the (mostly ASCII) JSON in half the bytes; `ISJSON`, `JSON_VALUE` and `OPENJSON` work unchanged, and the data layer parses these columns as before.
- **Page compression** on `events`, `health_samples`, `health_hourly`, `drive_samples`, `audit_log`, `commands`, `alerts` and their large indexes (Express supports it).
- **`events` is clustered on an ever-increasing `seq`**; `event_id` is the nonclustered primary key. New events append at the end instead of splitting pages all over a random-GUID index.
- **Indexes:** `events_alert` covers only events that have an alert; the index on `events.occurred_at` alone was dropped (no query used it: the fleet-wide 30-day reads cover the whole table). Added for retention: `commands_result_at` (filtered), `firewall_changes_occurred`, `diagnoses_started`, `cabinet_boots_booted`; for the offline jobs `alerts_open_issue`.
- **Command answers are stored out of the row**: page compression does not shrink `varchar(max)` values, and in the row a 3 KB answer left pages half empty and was read by every scan of the command history.
- **Load samples older than 48 hours become one row per hour** (min, average, max) in `health_hourly`; the trend chart and the disk-space forecast read both.
- **Events are kept 30 days by default** (was 90; a setting, see [open decisions](../spec/09-open-decisions.md)).

### Measured bytes per row (including the table's indexes)

Measured on SQL Server 2022 with synthetic rows shaped like real ones (System-log errors with real-looking messages; 3 KB software lists with per-cabinet differences; 400 days of SMART samples; audit entries for views, commands and results). Same rows in the old and the new table shapes.

| Table | Before | After | Why |
|---|---|---|---|
| events (1 row) | 1,248 B | 428 B | UTF-8, page compression, sequential key, fewer indexes |
| health samples (1 row, 15 min) | 53 B | 31 B raw, 35 B per hourly row | compression; 4 rows become 1 after 48 h |
| drive samples (1 row) | 208 B | 36 B | compression (model and serial repeat) |
| commands with a 3 KB answer | 8,230 B | 4,567 B | UTF-8, answer out of row (the answer itself is not compressed) |
| audit log (1 entry) | 1,061 B | 383 B | UTF-8 details, compression of table and its 4 indexes |

### Estimate at 10,000 cabinets

Assumptions (to check against the first real months): **20 events a cabinet a day** (Windows errors, warnings and changes on a quiet cabinet), 1.5 drives a cabinet with one report a day, **5,000 stored answers a day** fleet-wide and about 12,000 audit entries a day (both follow support activity, not the number of cabinets), retention at the defaults.

| | Rows kept | Before | After |
|---|---|---|---|
| events | 90 days → 30 days: 18 M → 6 M | 22.5 GB | 2.6 GB |
| command answers (90 days) | 450,000 | 3.7 GB | 2.1 GB |
| audit log (first year; never pruned) | 4.4 M | 4.6 GB | 1.7 GB |
| load samples (14 days) | 13.4 M → 2.9 M raw + 2.9 M hourly | 0.7 GB | 0.2 GB |
| drive samples (400 days) | 6 M | 1.2 GB | 0.2 GB |
| alerts, cabinets, the rest | | about 0.3 GB | about 0.2 GB |
| **Total** | | **about 33 GB: does not fit Express** | **about 7 GB** |

With command answers kept 30 days instead of 90 it is about 5.6 GB. What grows without limit is the audit log, about 1.7 GB a year at these assumptions; see [open decisions](../spec/09-open-decisions.md) "Database at 10,000 cabinets".

### What keeps the database healthy at night

- **Retention never runs as one big transaction.** Each table is trimmed with `DELETE TOP (4000) … WHERE <date> < @cut` (or `UPDATE TOP (4000)` for command answers) in autocommit statements, repeated until a statement changes fewer than 4,000 rows, with a 200 ms pause between them and a 30 s limit on each. Load and drive samples are trimmed per group of 40 cabinets through their primary keys (cabinet first). The run is audited at the end in its own small transaction. Notifications older than an hour go the same way, every hour.
- **It runs at a fixed quiet time**, 02:30 server time by default (`MAINTENANCE_AT=HH:MM`), not "five minutes after start".
- **The audit chain check is incremental**: each night from the checkpoint the last successful check left (`audit_checkpoint`, which only the `audit_checkpoint_advance` procedure can move, and only forward to an entry that exists with that hash); the whole chain on Sundays and whenever an Admin asks.

## Event ingest cost

An event batch used to cost about 9 round trips **per event** that raised or updated an alert (store it, read its issue type, take the alert lock, fold, insert, link the event, count the rule, find the site, take the site lock, flag the site pattern), plus a read of every live rule per batch: about 270 round trips for a batch of 30.

Now a batch costs **3 round trips** whatever its size (measured: 30 events with 3 signatures → 3, `server/test/scale.test.ts`): one `INSERT … SELECT FROM OPENJSON … WHERE NOT EXISTS` that also returns the rules stamp, one statement that takes the alert and site-pattern locks in name order and folds, inserts and flags all alerts of the batch, and one that links the events to their alerts and rules. Repeats of one signature fold once per batch; a resolve (scanner or service recovered) between two failures still splits them, exactly as one-by-one judging did. The live rules and issue types are kept in memory and reloaded only when their stamp (counts and checksums over `symptom_rules` and `issue_types`, read in the same statement as the insert) changes, or after 60 s. How often each rule matched is counted in memory and written every 60 s in one statement, so no batch waits on a hot rule row; the rule list adds what is not written yet.

## How the load test models the fleet (October 2026)

The load generator (`server/test/load/`) was rebuilt so that a run with 8,000 or 10,000 cabinets on a small server can be trusted: each simulated cabinet behaves like the real agent, over a network like the clinics' own, through the events that hurt a fleet (a server restart, a regional outage, mobile failovers). The measured results above predate it and the SQL Server port; they stay for comparison until new runs replace them.

### The simulated agent

Each simulated agent has its own cabinet, its own client certificate and its own TLS sessions, and follows the agent's code (`agent/src/Cabinet.Agent.Core/Server/AgentConnection.cs`, `Connectivity.cs`, `ResultOutbox.cs`, `AgentApiClient.cs`, `Monitoring/EventQueue.cs`). `--protocol 1.0` gives the agent as it was before Protocol 1.1, so runs can be compared before and after.

| | `--protocol 1.0` (the agent before 1.1) | `--protocol 1.1` (default; the agent now) |
|---|---|---|
| Connection | HTTP/1.1 pool, idle connections closed after 60 s, 10-minute lifetime, no TCP keepalive | HTTP/2 when the server offers it through ALPN, else HTTP/1.1 with idle connections closed after 20 s; lifetime 23 h + 0–120 min; TCP keepalive after 20 s idle, then a probe every 5 s (10 probes); HTTP/2 PING every 20 s, connection dropped after 10 s without an answer |
| Long poll | 25 s, client timeout 60 s, no acknowledgement; each command runs (and its result is posted) before the next poll | `?ack=` with the previous poll's command IDs (lower-case, at most 50); client timeout `pollSeconds` + 35 s; `pollSeconds` and `reconnectAfterMs` honoured; one worker runs commands in turn while polling goes on; a repeat offer is answered from the result outbox; a poll answered in under 1 s with nothing waits 1 s |
| Heartbeat | every 60 s, with a load sample | every 60 s until the server shows 1.1 (any pacing field), then `intervals.heartbeatSeconds` or 300 s; a load sample at most every 15 minutes; a drive report once a day |
| Results | 8 attempts with backoff, then given up | outbox, oldest first, until 2xx or 409; another 4xx drops it |
| Events | 100 per batch, back to back | 100 events and 256 KB per batch; gzip only after the server has shown 1.1, for bodies of 1 KB or more (415: plain for 24 h); halved after a refusal, an event refused alone 5 times set aside; paced only when the server sets `eventsPaceMs`; after a reconnection the main lane waits a random 0–120 s (security and agent-status events have their own lane, 1,000 deep, and do not wait); main queue 5,000 events |
| Failures | each loop backs off on its own (exponential, full jitter, 2 s to 5 min) | one shared state: a network error or 502/503/504 pauses every loop and one request at a time probes, with decorrelated jitter from 2 s capped at 5 minutes (0–30 s for the first retry after a live connection was reset); 429 waits only in the loop that got it; `Retry-After` honoured up to 10 minutes |

**Commands:** 70% `system.info` (0.2–1.4 s on the cabinet), 25% `eventlog.query` (2–20 s, a 50-entry page), 5% a 10-minute long command standing in for a software install, and 3% sent to cabinets that never connect (they expire and are reported separately). The install stand-in is `system.checkHealth` with a simulated 10-minute runtime: a real `package.install` needs an approved package, a step-up code and a write limit, none of which a load run should exercise. Commands go through the server's own issuing path (`issueCommand`), 2 a second by default, from 30 s after the ramp until `--drain-seconds` (120 s) before the end, so every delivery can settle before the database is checked.

**Events:** 6 an hour per cabinet by default (Poisson; a fifth arrive in bursts of 2 to 10): log errors, update installs, service restarts, scanner disconnects, firewall changes, SMART warnings and agent-status events, about 3% of them repeating an earlier event's ID (a record read again).

**Clock skew:** 2% of the cabinets run 1 to 3 minutes fast or slow; their timestamps and reported skew follow, and they check command expiry against their own clock.

**Fleet shape:** setup creates sites of 1 to 6 cabinets (about 3 on average) in clients of 500, each site in one of ten regions, plus 2% extra cabinets that never connect.

### Simulated links

Every agent's TCP connections run through an in-process relay (`server/test/load/link.ts`; no root, no `tc`): bytes go to a real TCP connection to the server with the link's delay, loss and bandwidth applied, and a NAT or a failover can silently black-hole them. The server sees ordinary connections, half-dead ones included. Bytes are counted at the relay (TLS bytes, plus an estimate of TCP/IP headers).

| Class | Default share | Round trip (lognormal) | Loss (as retransmit delay) | NAT idle timeout | Failovers | Bandwidth down / up |
|---|---|---|---|---|---|---|
| fiber | 60% | median 25 ms, p99 80 ms | none | none | none | 100 / 40 Mbit/s |
| DSL | 25% | median 60 ms, p99 300 ms | 0.5% | 120 s | none | 16 / 1 Mbit/s |
| 4G | 12% | median 120 ms, p99 800 ms | 2% | 30–60 s, flows dropped silently | every 6 h ± 3 h, every socket black-holed for 30–90 s; connections open before it stay dead | 20 / 5 Mbit/s |
| bad | 3% | median 500 ms, p99 1.5 s | 5% | 30 s | none | 1 / 0.25 Mbit/s |

- `--links fiber=60,dsl=25,4g=12,bad=3` sets the mix. Each cabinet's class follows from `--seed` and its cabinet ID, so runs are repeatable.
- How a dead connection is noticed is modelled: data written into it is retransmitted and the connection reset after about 20 s; an idle one is found by the keepalive probes (1.1) or not at all (1.0, until the request times out). The server's side of a dead connection stays open until the server closes it or about 15 minutes pass.
- `--time-compression C` runs the multi-hour behaviours C times faster: 4G failovers and the daily drive report. Protocol timings (polls, heartbeats, NAT timeouts, backoffs) always run in real time, because the server is real. With 18 (the `run.sh` default) each 4G cabinet fails over about once every 20 minutes. Bytes per cabinet per day are measured in real time over the steady phase and include the compressed failovers, so they slightly overstate a real day of a 4G cabinet.

### Scenarios (`--scenario`)

| Scenario | What happens | What it shows |
|---|---|---|
| `steady` | ramp over `--ramp-seconds` (120), then steady load | the baseline and the thresholds below |
| `restart` | at `--restart-at-minute` (5) the server is stopped and started again by `--restart-exec` (`run.sh` passes a script that sends SIGTERM and starts the server on the same cores; without it the run says when to restart by hand and waits for `/health`) | reconnection times, 503s while closing, commands caught in the restart, site-outage alerts that must not appear |
| `no-ramp` | every agent connects within 2 s | the handshake storm |
| `regional-outage` | at `--outage-at-minute` (4), 30% of the regions (whole sites) are black-holed for `--outage-minutes` (20), then released together; `--preload-hours 72` gives those cabinets the event backlog of a 3-day outage | event drain time, reconnection, isolation of the cabinets not affected, site-outage alerts for the right sites |
| `nat-drop` | 4G links only, without failovers | whether NAT timeouts break connections (1.0 has no keepalive; 1.1 has) |
| `failover-during-command` | 4G only, a failover every `--failover-every-minutes` (4) per cabinet, and half of the commands sent to cabinets whose link is down at that moment | commands issued during a blackout must be delivered after the reconnect |
| `event-storm` | 1% of the cabinets send one event a second for the whole run | the ingest quota (429) touches only those cabinets |

### What a run reports

The summary is printed and written as JSON (`--report`):

- requests per second by kind, overall and in the steady phase; outcomes by status; peak 503 and 429 per second;
- new TLS connections per second, full and resumed (`tlsSocket.isSessionReused()`), the HTTP version the server chose, open connections;
- bytes up and down per cabinet per day by link class (counted at the relay, steady phase);
- latency per request kind (all cabinets, and fiber cabinets in the steady phase, which shows the server's own speed);
- command delivery (issue to the cabinet holding it) p50/p95/max per link class; commands issued while the target's link was down and how long after the link came back they arrived; repeat offers;
- **lost commands**: delivered according to the database but never received by the agent; **undelivered commands** to cabinets whose link was up for the command's whole life; commands to never-connected cabinets;
- **lost results**: accepted by the server (2xx or 409) but not in the database, or given up by a 1.0 agent; results still in an outbox at the end;
- **false offlines**: a cabinet more than 5 minutes without contact (a poll or heartbeat for 1.1, a heartbeat for 1.0), not counting the time its link was down; and the server's own view, sampled from the database every 30 s (`last_contact_at`, or `last_heartbeat_at` while that is the column): cabinets with no recorded contact for 6 min 10 s (presence may be written up to a minute late) whose link was up;
- site-outage alerts raised during the run, for sites in the outage and elsewhere;
- time for 50/95/99/99.9% of the cabinets to be back after a restart (from the kill and from the server answering `/health`) or after an outage, and cabinets not back at the end;
- event drain time after an outage, events sent, duplicates, gzip use, events dropped or set aside;
- heartbeat and event latency of the cabinets outside the outage, during it and in the steady phase (isolation);
- server process CPU (% of one core) and memory, and the SQL Server process's, sampled every 5 s from `/proc` (SQL Server's figures are the whole instance: on a shared machine they include other databases).

## Thresholds

The run fails when any of these is missed (`THRESHOLDS` in `server/test/load/run.ts`).

| | Limit |
|---|---|
| Lost commands (delivered by the server, never received by the agent) | none |
| Commands to reachable cabinets never delivered | none |
| Commands issued during a blackout never delivered (`failover-during-command`) | none |
| Lost results | none |
| False offlines: agent view (`steady`, `no-ramp`, `restart`), server view (`steady`, `restart`) | none |
| After a restart, 99% of cabinets back | within 3 minutes of the server answering again |
| Site-outage alerts after a restart | none |
| Full TLS handshakes in the steady phase | at most 1% of requests |
| Command delivery p95 | under 3 s on fiber and DSL, under 10 s on 4G and bad links |
| Heartbeat, fiber cabinets, steady phase | p95 under 1 s, p99 under 3 s |

## Running it

### One command

```sh
cd server && npm ci && npm run build
MSSQL_SA_PASSWORD=… test/load/run.sh <scenario> <agents> <minutes> [more agents.js run options]
```

`run.sh` creates a database and a login for this run only, applies the migrations, makes a development PKI, sets up the cabinets and their certificates, starts the server pinned to its cores with a heap cap, runs the generator on the other cores, and tears everything down at the end (server stopped, database and login dropped, private keys deleted). The report and the server log stay in `OUT_DIR` (default `./load-results`). Settings, all through the environment:

| Variable | Default | |
|---|---|---|
| `MSSQL_SA_PASSWORD` | (required) | the SQL Server owner's password; never stored in the repository |
| `MSSQL_HOST`, `MSSQL_PORT` | localhost, 1433 | |
| `SERVER_CORES` | 0,1 | `taskset` cores for the server process |
| `GEN_CORES` | 2,3 | `taskset` cores for the load generator (and setup) |
| `SERVER_HEAP_MB` | 1024 | the server's JavaScript heap cap (`--max-old-space-size`) |
| `DB_MEMORY_MB` | unchanged | SQL Server `max server memory` for the run (what `MSSQL_MEMORY_LIMIT_MB` does, without recreating the container); put back afterwards |
| `DB_CPUS` | unchanged | `docker update --cpus` on the SQL Server container (`MSSQL_CONTAINER`, default `mssql`) for the run; set back to unlimited afterwards |
| `PROTOCOL` | 1.1 | 1.0 for the agent before Protocol 1.1 |
| `TIME_COMPRESSION` | 18 | |
| `RAMP_SECONDS` | 120 | |

### The small-server profile

The profile stands for a 2 vCPU / 4 GB application server with SQL Server Express, on a 4-core machine:

- the server on 2 cores with a 1 GB heap: `SERVER_CORES=0,1 SERVER_HEAP_MB=1024`;
- SQL Server: Express itself uses at most 4 cores and about 1.4 GB of buffer pool; to hold it to the profile, `DB_MEMORY_MB=2048 DB_CPUS=2` (or, when the container is created, `MSSQL_MEMORY_LIMIT_MB=2048`, `--cpus 2` and `MSSQL_PID=Express`);
- the generator on the remaining cores: `GEN_CORES=2,3`. In this layout it shares cores with SQL Server; for a clean measurement run it on a second machine (`agents.js run --server https://<host>:8443` with the state file copied there).

10,000 and 8,000 cabinets, the steady baseline first and then the disturbances:

```sh
export MSSQL_SA_PASSWORD=… SERVER_CORES=0,1 GEN_CORES=2,3 SERVER_HEAP_MB=1024 DB_MEMORY_MB=2048 DB_CPUS=2
for n in 10000 8000; do
  test/load/run.sh steady          $n 20
  test/load/run.sh restart         $n 20 --restart-at-minute 8
  test/load/run.sh no-ramp         $n 10
  test/load/run.sh regional-outage $n 40 --outage-at-minute 5 --outage-minutes 20 --preload-hours 72
  test/load/run.sh failover-during-command $n 20
  test/load/run.sh event-storm     $n 20
  PROTOCOL=1.0 test/load/run.sh steady $n 20      # before/after comparison
done
```

- Each cabinet holds at least one connection on each side, so the machine needs a high open-file limit (`run.sh` raises the soft limit to the hard limit; 10,000 cabinets need about 25,000 descriptors per process).
- `--workers W` spreads the agents over worker threads (default one per 2,500 agents, at most one per core).
- Setting up 10,000 cabinets (a key and certificate each) takes a few minutes.

### By hand

```sh
DATABASE_URL=sqlserver://… DEV_PKI_DIR=… node dist/test/load/agents.js setup --count 8000 --state load-state.json
DATABASE_URL=sqlserver://… node dist/test/load/agents.js run --server https://<agent-api-host>:8443 --state load-state.json \
  --scenario steady --minutes 20 --server-pid <pid> --report report.json
rm load-state.json   # it holds the test cabinets' private keys
```

- Without `DATABASE_URL`, the run issues no commands and checks nothing in the database.
- `--first N` uses only the first N agents; `agents.js run --help` lists every option.
- The generator's own tests (response parser with hostile input, the relay, backoff, batching, and the 1.1 agent model against a small 1.1 server): `npm run build && node --test dist/test/load/load-tools.test.js`.

**In CI:** every push runs 1,000 agents for 3 minutes (the "Agent API under load" step of `.github/workflows/platform-contracts.yml`); with the new generator that is the `steady` scenario with the default link mix and the thresholds above.

## Still to do before going wide

Repeat the 8,000-agent run against the production hosting and database, with the load generator on a separate machine, once hosting is decided ([open decisions](../spec/09-open-decisions.md)).

When going wider than 8,000 cabinets, or when one process is no longer enough, the agent API can run as several processes behind a load balancer: command announcements already reach every process through PostgreSQL.

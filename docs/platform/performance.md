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

## Thresholds

The load tool fails the run when any of these is missed. They are in `server/test/load/agents.ts` (`THRESHOLDS`).

| | Limit |
|---|---|
| Failed requests | at most 0.1% |
| Heartbeat | p95 under 1 s, p99 under 3 s |
| Event batch | p95 under 2 s |
| Command delivery | p95 under 3 s; none over 26 s (one long poll) |
| Commands never delivered | none |

## Running it

```sh
cd server && npm ci && npm run build
# 1. Cabinets with their own certificates (uses the server's database and development issuing key).
DATABASE_URL=postgres://… DEV_PKI_DIR=… node dist/test/load/agents.js setup --count 8000 --state load-state.json
# 2. The run, against a running server.
DATABASE_URL=postgres://… node dist/test/load/agents.js run --server https://<agent-api-host>:8443 --state load-state.json \
  --minutes 10 --ramp-seconds 120 --commands-per-second 2 --events-per-hour 6 --report report.json
# 3. The state file holds the test cabinets' private keys.
rm load-state.json
```

- Without `DATABASE_URL`, the run issues no commands and measures only polls, heartbeats and events.
- `--first N` uses only the first N agents.
- One Node.js process can drive 8,000 agents. With `--first` and separate state files, it can be split across machines.

**In CI:** every push runs 1,000 agents for 3 minutes against the same thresholds (the "Agent API under load" step of `.github/workflows/platform-contracts.yml`).

## Still to do before going wide

Repeat the 8,000-agent run against the production hosting and database, with the load generator on a separate machine, once hosting is decided ([open decisions](../spec/09-open-decisions.md)).

When going wider than 8,000 cabinets, or when one process is no longer enough, the agent API can run as several processes behind a load balancer: command announcements already reach every process through PostgreSQL.

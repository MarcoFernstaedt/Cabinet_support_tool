# Agent and Server Protocol

This is the contract between agent and server. Both sides are built against the JSON Schema files in the contracts folder, which are the source of truth. All messages are JSON over HTTPS with mutual TLS. All times are UTC in ISO 8601 format.

## Endpoints the agent calls

- POST /agent/v1/enroll: send the certificate signing request, bootstrap token and fingerprints. Reachable without a client certificate (with the status poll below and /health). Rate-limited per source (an IPv4 address or an IPv6 /64).
- GET /agent/v1/enroll/{requestId}: poll for approval. Returns pending, rejected, or the issued certificate. Rate-limited per source. Traffic without a verified client certificate never draws on the admission buckets the enrolled fleet uses: it has small buckets of its own, per source and in total, and is answered 429 with Retry-After past them. Only the routes that require a client certificate use the fleet's buckets, so a revoked certificate cannot spend them on health, enrollment or unknown paths, and a certificate refused once is treated as certificate-less for ten minutes. Certificate-less requests that reach the database (enrollment and its status) share a small total of their own. Open connections are capped per source and in total before TLS, and a TLS handshake must finish within 10 seconds.
- GET /agent/v1/commands: long poll. The server holds the request up to 25 seconds and returns any waiting commands, or an empty list.
- POST /agent/v1/results: report the result of a command.
- POST /agent/v1/heartbeat: every 60 seconds (Protocol 1.0) or at the server-directed interval (1.1, default 300 seconds), with agent version, uptime and read-only mode.
- POST /agent/v1/events: report detected errors and changes in batches.
- POST /agent/v1/renew: renew the agent certificate before it expires.
- GET /agent/v1/packages/{packageId}: download an approved software library package. The server serves it only while a package.install command for that package and that cabinet is open.
- GET /agent/v1/updates/{version}: download a signed agent update package.

There is no general file download endpoint.

## Command envelope

```json
{
  "commandId": "uuid",
  "cabinetId": "uuid",
  "operation": "eventlog.query",
  "params": {},
  "issuedBy": "user-uuid",
  "issuedAt": "2026-10-04T19:00:00Z",
  "expiresAt": "2026-10-04T19:05:00Z"
}
```

- operation must be a name from the agent catalog.
- params must validate against that operation's schema.
- The agent checks that cabinetId is its own ID.
- For package.install, params carry the package ID, package type and SHA-256 hash.

## Result envelope

- commandId: the command this answers
- status: succeeded, failed or rejected
- startedAt and finishedAt
- output: matches the operation's output schema; present when succeeded
- error: a code and a message; present when failed or rejected

Rejection codes: unknown_operation, invalid_params, expired, replayed, wrong_cabinet, read_only_mode, rate_limited, hash_mismatch, signature_invalid, publisher_not_trusted, verification_failed.

## Event envelope

- eventId: unique, so retries do not create duplicates
- kind: error, firewall_changed, smart_warning, agent_status or security
- occurredAt
- source: for errors, the log name, source, event ID, level and record ID; the device hardware ID and instance ID when a device is involved
- commandId: on firewall_changed, the platform command that caused it, if any
- severityHint: the agent's own reading; the server makes the final classification
- detail: message text and structured fields, size-capped

Security events cover a failed self-check of the agent's own files, a refused package, and a safety-net rollback.

## Timing and limits

- Heartbeat every 60 seconds (1.0; 300 seconds by default in 1.1, where polls also count as contact). A cabinet with no contact for 5 minutes shows as offline.
- Clock skew tolerance 2 minutes. The server returns its own time on every response so the agent can detect drift and report it.
- Request bodies capped at 1 MB except package and update downloads.
- Events batched up to 100 per request. If the server is unreachable, the agent queues events on disk up to a size cap and sends them when connected, oldest first.

## Error handling

- Network failures (refused, timed out, reset): the agent retries with decorrelated-jitter backoff from about 2 seconds, capped at 60 seconds between attempts, so a cabinet is back within about a minute of the server returning; the jitter keeps 10,000 agents from reconnecting at the same instant. Waits the server sends (Retry-After, reconnectAfterMs) are honoured up to 10 minutes.
- Commands arriving after expiry are rejected, not run late.

## Protocol 1.1: delivery, pacing and bad networks (October 2026)

Added after the scale and resilience review (docs/platform/performance.md). Backward compatible: every new field is optional, and an agent or server that ignores them behaves as 1.0.

- **One connection per agent.** The agent keeps one long-lived TLS connection (HTTP/2 where the server offers it, otherwise HTTP/1.1 keep-alive with TCP keepalives every 20 s), so polls, heartbeats, events and results share it and a full TLS handshake happens about once a day instead of on most requests.
- **Leased command delivery.** `GET /agent/v1/commands?ack=<id>,<id>` acknowledges commands the agent received on the previous poll. A command handed to a poll is leased for 30 seconds; if neither the acknowledgement nor its result arrives, the next poll offers it again (the agent's replay store and result outbox make a repeat harmless: it answers with the stored result). A command is never lost to a poll whose answer went into a dead connection.
- **Durable results.** The agent writes each result to an on-disk outbox before posting it, posts it from its own loop until the server accepts it (409 means already stored), and keeps polling while a long command runs.
- **Presence.** A poll or a heartbeat counts as contact; the server records contact in memory and writes it in one batched statement a minute. A cabinet with no contact for 5 minutes is offline (unchanged).
- **Server-directed pacing.** The heartbeat answer may carry `intervals` (`heartbeatSeconds` 60–900, default 300 in 1.1; `pollSeconds` 15–110; `eventsPaceMs` 0–60000) and the poll answer `pollSeconds`. Health samples stay at one per 15 minutes. An Admin sets the three pacing values in the console (Admin -> Settings); the server clamps them to these ranges and agents pick them up with a heartbeat answer.
- **Admission control.** Under load the server answers `503` (or `429` for quotas) with a randomised `Retry-After` (30–90 s) for database or event-loop overload; a refusal given only because new connections arrive faster than the admitted rate (default 300 a second, burst three times that, `AGENT_NEW_CONNECTIONS_PER_SECOND`) costs nothing to give and carries `Retry-After` 3–15 s, so a fleet returning after a restart is let in quickly. The agent waits at least that long. **A 502, 503, 504 or 429 pauses only the endpoint that received it** (heartbeat, results or events), for at least its `Retry-After` (never more than 10 minutes; a missing, negative or garbled value counts as none) or that endpoint's own backoff; the other loops, the long poll above all, carry on, because the answer proves the server was reached. Only real network failures (no answer at all) pause every loop through the shared connectivity state. A long poll turned away for load is answered `200` with no commands and a `reconnectAfterMs` of 10–30 s instead: a poll costs the database almost nothing, and a cabinet sent away for a minute could not receive a command for that long. On shutdown the server ends every held poll with `reconnectAfterMs` spread over 0–60 s, so a restart does not bring every cabinet back in the same second. The agent's network backoff is decorrelated jitter capped at 60 seconds, and all loops share one connectivity state.
- **Events.** Batches are capped at 256 KB as well as 100 events, may be gzip-compressed (`Content-Encoding: gzip`, 1 MB after decompression), are halved on 413, and a batch that keeps failing sets its first event aside so one bad event cannot stall the queue. After an outage the backlog is drained at the pace the server sets. Security and agent-status events have their own queue that is never evicted, and the agent reports how many events it had to drop.
- **Outage awareness.** After the server itself was down or unreachable, offline and site-outage judgements wait until every cabinet has had time to come back, so a server restart does not raise an alert for every site.

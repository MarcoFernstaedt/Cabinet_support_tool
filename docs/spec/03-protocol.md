# Agent and Server Protocol

This is the contract between agent and server. Both sides are built against the JSON Schema files in the contracts folder, which are the source of truth. All messages are JSON over HTTPS with mutual TLS. All times are UTC in ISO 8601 format.

## Endpoints the agent calls

- POST /agent/v1/enroll: send the certificate signing request, bootstrap token and fingerprints. The only endpoint reachable without a client certificate. Rate-limited.
- GET /agent/v1/enroll/{requestId}: poll for approval. Returns pending, rejected, or the issued certificate.
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

- Network failures: the agent retries with exponential backoff, capped at 5 minutes between attempts, with random jitter so 8,000 agents do not reconnect at the same instant.
- Commands arriving after expiry are rejected, not run late.

## Protocol 1.1: delivery, pacing and bad networks (October 2026)

Added after the scale and resilience review (docs/platform/reviews.md). Backward compatible: every new field is optional, and an agent or server that ignores them behaves as 1.0.

- **One connection per agent.** The agent keeps one long-lived TLS connection (HTTP/2 where the server offers it, otherwise HTTP/1.1 keep-alive with TCP keepalives every 20 s), so polls, heartbeats, events and results share it and a full TLS handshake happens about once a day instead of on most requests.
- **Leased command delivery.** `GET /agent/v1/commands?ack=<id>,<id>` acknowledges commands the agent received on the previous poll. A command handed to a poll is leased for 30 seconds; if neither the acknowledgement nor its result arrives, the next poll offers it again (the agent's replay store and result outbox make a repeat harmless: it answers with the stored result). A command is never lost to a poll whose answer went into a dead connection.
- **Durable results.** The agent writes each result to an on-disk outbox before posting it, posts it from its own loop until the server accepts it (409 means already stored), and keeps polling while a long command runs.
- **Presence.** A poll or a heartbeat counts as contact; the server records contact in memory and writes it in one batched statement a minute. A cabinet with no contact for 5 minutes is offline (unchanged).
- **Server-directed pacing.** The heartbeat answer may carry `intervals` (`heartbeatSeconds` 60–900, default 300 in 1.1; `pollSeconds` 15–110; `eventsPaceMs` 0–60000) and the poll answer `pollSeconds`. Health samples stay at one per 15 minutes.
- **Admission control.** Under load the server answers `503` (or `429` for quotas) with a randomised `Retry-After`; the agent waits at least that long. On shutdown the server ends every held poll with `reconnectAfterMs` spread over 0–60 s, so a restart does not bring every cabinet back in the same second. The agent's backoff is decorrelated jitter capped at 5 minutes, and all loops share one connectivity state.
- **Events.** Batches are capped at 256 KB as well as 100 events, may be gzip-compressed (`Content-Encoding: gzip`, 1 MB after decompression), are halved on 413, and a batch that keeps failing sets its first event aside so one bad event cannot stall the queue. After an outage the backlog is drained at the pace the server sets. Security and agent-status events have their own queue that is never evicted, and the agent reports how many events it had to drop.
- **Outage awareness.** After the server itself was down or unreachable, offline and site-outage judgements wait until every cabinet has had time to come back, so a server restart does not raise an alert for every site.

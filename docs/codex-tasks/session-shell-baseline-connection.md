# Harness: the off-network baseline must not wait for a completed response

## Observed on real hardware (2026-11-17, HP `deviceb`, branch `feat/remote-access-tunnel`)

Run: `bash /home/marco/.hermes/scripts/run-off-network-acceptance.sh` (public ingress = Tailscale
Funnel raw TCP `8443 -> tcp://localhost:18443`, harness listening on `SHELL_PLATFORM_LISTEN_PORT`,
advertising `SHELL_PLATFORM_PORT=8443`).

What the agent log shows, in order and without error:

```
Enrollment request 6cf1cb33-194b-40cc-9263-d37b8875931f sent; waiting for an administrator to approve it.
Enrolled as cabinet 164f1cb1-28dc-4273-b5d3-b8c85abd09d1.
Connected to the platform server.
Connected to the platform server.
```

So enrollment, approval, heartbeat (`first heartbeat` passed) and the opt-in capability all
worked. The run then failed at:

```
Error: Timed out: authenticated baseline agent connection
    at until (.../session-shell-cabinet.mjs:137:9)
    at async .../session-shell-cabinet.mjs:213:5
```

## Why

Line 213 waits for an entry in `connections`, and `connections` is only filled by the
`onResponse` hook (line 172). An agent that has just (re)started establishes its mTLS
connection and issues a **long-poll** request that by design does not produce a response until
there is something to hand the agent. `onResponse` therefore fires long after the `until`
window, so a healthy, authenticated agent looks absent.

The connection itself is fine: the same socket passes the `secureConnection` hook, which is
exactly what the later checks need. Nothing about the ingress is at fault — this check has
never run against hardware before, which is why only the live run exposes it.

## What to change (only `scripts/acceptance/session-shell-cabinet.mjs`)

- Record a candidate connection when the request is known to be an **authenticated agent
  request**, not when its response finishes: the connection observation must survive a
  request that is still open (long-poll). Keep recording the **socket peer**
  (`request.raw.socket.remoteAddress`) and the cabinet id; never trust a forwarded header.
- The baseline check (line 213) and the post-Tailscale-drop check (line 231) must both work
  off that record, unchanged in what they assert:
  - baseline: an authenticated connection for this cabinet exists and its socket is not
    destroyed;
  - after the drop: the *fresh* connection is a new socket (the pre-drop sockets were
    destroyed and the record cleared), and `assert.ok(!tailnetAddress(peerAddress))` still
    runs — a tailnet or IPv4-mapped-tailnet peer must still fail the run.
- Do not weaken anything: no new environment flag, no skipping certificate verification, no
  production default or threshold changes, no change to `server/`, `console/` or `agent/`
  behaviour, and with `SHELL_OFF_NETWORK` unset the harness must behave exactly as today.
- `node --check` must pass and the existing regression tests must stay green.

Leave the working tree **uncommitted** on `feat/remote-access-tunnel` for review, and report
what you changed plus the reviewer command. You cannot SSH to the cabinet: do not claim a
hardware result you did not produce.

# Remote access to a cabinet, through the product (F22)

**Branch:** `feat/remote-access-tunnel` (off `main`; do not work on `main`).
**Owner's instruction (2026-11-15):** build the tunnel so the operator can reach any machine the agent runs on, whatever
network it is on, to find out why it failed and fix it — and installing an agent is what enables that access. This branch
becomes the deployed build.

F22 ("Our own remote access") has been **parked by the owner since 2026-11-06**. This brief un-parks it. Write the decision
down in `docs/spec/09-open-decisions.md` as a numbered entry (next D-number) in the same voice as its neighbours: what was
decided, what it costs, and what it rules out.

## What must be true of the design

The spec is explicit that the agent is "a potential remote code execution channel into 8,000 cabinets in healthcare
settings" (`docs/spec/02-security-model.md:5`), and lists "an attacker taking over the server" as the first threat. So:

- **Outbound only.** A cabinet is on its own network and the agent already dials the server with mutual TLS — long poll
  `GET /agent/v1/commands`, `POST /agent/v1/results`, heartbeat, events, renew (`docs/spec/03-protocol.md`). The tunnel
  rides that direction. **No listening socket is added to the cabinet, ever, and no third-party tunnel agent
  (cloudflared, Tailscale, ngrok or similar) is installed on it.** The agent must keep working with no internet access and
  no inbound port.
- **Never anonymous, never shared.** A session is opened by one identified operator, on one cabinet, and every session is
  audited: who, which cabinet, when it opened and closed, why, and what was typed. Use the console's existing step-up
  mechanism — `stepUp(userId, token, action, target)` in `server/src/console-api/admin-routes.ts` — the same way rollouts
  and enrollment approvals use it.
- **Bounded and killable.** An idle timeout, a maximum session length, one live session per cabinet, a small fleet-wide
  cap, and a way to end any session from the console. A session that ends must free the cabinet immediately.
- **Visible.** A session shows in the console while it is live, and the cabinet records it locally, so an on-site engineer
  can tell that someone is on the machine.

## The job

1. **The relay.** Add the transport that lets the console and an agent exchange bytes, agent-initiated over the existing
   mTLS agent connection. Extend `agent/src/Cabinet.Agent.Core/Server/AgentConnection.cs` and the agent routes in
   `server/src/agent-api/server.ts`. Prefer reusing the existing long poll if it can carry an interactive session honestly;
   if the latency cannot be met, add a dedicated streamed route in the same style, under the same client-certificate
   requirement and the same rate-limit buckets as the other fleet routes. Frames carry bytes and nothing else: the server
   does not parse what an operator types.
2. **Opening and closing.** A `session.open` command from the server (the command envelope in `docs/spec/03-protocol.md`)
   carries the session id and kind. The agent refuses when the local policy forbids it, when a session is already live, or
   when the certificate is not valid. Closing is explicit from either side, and also on idle. Every state change is an
   audit row and a server-side session record.
3. **The capability on top.** A remote PowerShell session on the cabinet, because the owner needs to diagnose and fix, not
   only read. Run it in the agent's existing broker/child-process style, with the transcript captured, the process's exit
   recorded, and a hard cap on session length. If you judge that a narrower capability is the better engineering answer, say
   so in the decision entry and implement that instead — but the owner's need is to see why a machine failed and fix it.
4. **The console surface.** A page under the cabinet (`console/src/pages/cabinet/`) that lists live sessions, starts one
   behind the existing permission **and** a step-up token, streams the transcript, and ends the session. Follow the
   console's existing idiom for pages, permissions and step-up; do not invent a new auth path. A role without the permission
   must be refused by the server, not merely hidden in the UI.
5. **Install enables it.** `agent/install/Install-CabinetAgent.ps1` writes the agent configuration that allows sessions,
   with a local switch to turn it off on a cabinet, and the agent honouring that switch. The local record of a session must
   survive the session.
6. **Prove it.** At minimum, tests that: a session cannot start without a step-up token; a session cannot start for a role
   without the permission; the audit row and session record are written on open and on close; an idle session ends by
   itself; the agent refuses when its local policy is off; a second session on the same cabinet is refused; and **the agent
   opens no listening socket** — assert that the cabinet's port set is unchanged while a session is live.

## Rules that are not negotiable

- Nothing in this feature may work if the cabinet's local policy is off, or if the operator's step-up is missing.
- No hidden channel, no credential harvesting, no bypass of the console's session and role checks, no path that skips the
  audit. If a design choice would not survive the security review of `docs/spec/11-security-review-brief.md`, it is wrong.
- Do not weaken a test assertion to fit. Do not delete another feature's test to make room.
- Copy the suite's own command from the repository; the server suite is `node --test --test-concurrency=2` and needs
  `TEST_DATABASE_ADMIN_URL` exported. Never hand-roll a test invocation.
- Red/green only, and no non-zero exit hidden. What this sandbox cannot do (SQL Server on `127.0.0.1:11433`, Windows-only
  agent paths, a real cabinet) must be named with the exact command the reviewer should run, never faked.
- The agent stays `net10.0-windows` and keeps publishing both `win-x64` and `win-x86`.
- Commit nothing until the change is complete on the branch; then commit as `Marco Fernstaedt
  <fernstaedtmarco@gmail.com>`, with no generator trailer, no session URL, no "generated by" footer, no emoji.

## Not in this task

The separately-briefed update-signing work (`docs/codex-tasks/updates-without-a-purchase.md`) — if you need its signing
step, assume it lands separately and do not duplicate it. The cross-module write paydown.

# Remote access to a cabinet, through the product (F22) — revision 4

**Branch:** `feat/remote-access-tunnel` (off `main`; do not work on `main`).
**Owner's instruction (2026-11-15):** build the tunnel so the operator can reach any machine the agent runs on, whatever
network it is on, to find out why it failed and fix it — and installing an agent is what enables that access. This branch
becomes the deployed build.

**Revision 5 (2026-11-16).** Revision 4 ran and got further: the server build passed, the console build passed, and the
console suite ran 32/32, but it stopped **before implementing** because `dotnet build agent/Cabinet.Agent.sln -c Release`
answered `dotnet: command not found`. The SDK is at `/home/marco/.dotnet` and off the default PATH. The Environment
section below now carries the exact export, verified by running that build here. No code was written and the tree was left
clean, so nothing has to be un-done.

**Revision 4 (2026-11-16).** Revision 3's rule "Do not create any file outside the ones the task names" was read —
correctly — as banning `contracts/schemas/operations/session.open.schema.json`, which item 2 cannot be built without:
`server/src/contracts.ts:326` builds every operation's validator from `operations/<name>.schema.json`, and
`docs/spec/03-protocol.md:3` makes those schema files the source of truth. The rule now says what it means, under
"Files you may add" below, and nothing else changed. The run that stopped was right to stop: it named the file it needed
instead of guessing.

**Revision 3 (2026-11-16).** Revision 2's item 3 asked for "a remote PowerShell session on the cabinet". The spec forbids
exactly that, and the run stopped on it rather than build it. The rules it stopped on, quoted:

- `docs/spec/02-security-model.md:13` — "There is no shell, no script runner, no general file transfer and no way to run
  an arbitrary file."
- `docs/spec/02-security-model.md:11` — "The catalog is compiled into the agent. The server cannot add operations; only a
  signed agent upgrade can."
- `docs/spec/11-security-review-brief.md:29` — under "What the platform cannot do": "Run commands, scripts, EXE files or
  anything outside its fixed list".
- `docs/spec/11-security-review-brief.md:31` — same list: "Read the CUBEX application, its database, or the Windows
  Security log".

Item 3 is rewritten below to the compatible capability: **a live read-only stream of the agent's own diagnostic output,
and the cabinet's existing catalogued operations run inside the session, each as its own audited operation.** No shell,
no script runner, no arbitrary command, no general file transfer. `docs/spec/04-agent-spec.md:33` is the acceptance step
this rides on ("The operation name is in the catalog"), and the catalog itself is
`agent/src/Cabinet.Agent.Contracts/Catalog.cs`. Whether the owner wants a general shell anyway is an owner decision and is
**not in this task**: it would require changing `02-security-model.md:13` and `11-security-review-brief.md:29` first.

**Revision 2 (2026-11-16)** corrected two premises of revision 1, both checked against the tree rather than the notes:

- The step-up call is `consumeStepUpToken(db, token, userId, action, target)` in `server/src/auth/stepup.ts:37`, and a
  route that needs it wraps it as `transaction(o.pool, c => consumeStepUpToken(c, token, userId, action, target))`
  (`server/src/console-api/admin-routes.ts:21`), taking the token from the body with `boundTo(body.stepUpToken, body)`
  (`server/src/console-api/setup-routes.ts:119`). There is no `stepUp(...)` function in `admin-routes.ts`; the shape
  named in revision 1 was right and its name and file were not.
- The numbered entry goes in `docs/platform/decision-log.md`, whose entries read `## D<n>. <title>` (highest today: D97),
  so this one is **D98**. The existing behaviour is described in `docs/platform/remaining-phases.md`: line 41 ("F23 is
  closed. F22 is parked by the owner.") and the table row at line 646 (`| 15 | Our own remote access | F22 | **Parked**
  by the owner, 2026-11-06 |`). Write **both** the decision entry and the change to that row; `docs/spec/09-open-decisions.md`
  holds the owner-facing item and takes the same text in its voice, without a D-number.

Everything else below was checked before revision 2 was committed: `docs/spec/02-security-model.md:5` carries the quoted
sentence; `server/src/agent-api/server.ts` serves `GET /agent/v1/commands` (lines 389, 616), `POST /agent/v1/results`
(442, 656), `POST /agent/v1/heartbeat` (661) and `POST /agent/v1/events` (612); `console/src/pages/cabinet/` exists; the
suite commands quoted under "Rules" are the repository's own (`server/package.json:12`, `console/package.json:11`).

## Environment, verified before this revision (2026-11-16)

- **`dotnet` is not on the default PATH on this machine.** It lives at `/home/marco/.dotnet`, so put it there first:
  `export PATH=$HOME/.dotnet:$PATH`. With that export, `dotnet build agent/Cabinet.Agent.sln -c Release` succeeds on this
  tree (run here: 0 warnings, 0 errors, 47s). Without it the command is `dotnet: command not found` (exit 127), and a run
  that checks the build before implementing stops before writing anything.
- SQL Server for the server suite listens on `127.0.0.1:11433`; export `TEST_DATABASE_ADMIN_URL` as the suite requires
  before running it.
- A missing binary is this section's PATH line, not the brief being wrong. Do not stop on it: export and carry on.

## What must be true of the design

The spec is explicit that the agent is "a potential remote code execution channel into 8,000 cabinets in healthcare
settings" (`docs/spec/02-security-model.md:5`), and lists "an attacker taking over the server" as the first threat. So:

- **Outbound only.** A cabinet is on its own network and the agent already dials the server with mutual TLS — long poll
  `GET /agent/v1/commands`, `POST /agent/v1/results`, heartbeat, events, renew (`docs/spec/03-protocol.md`). The tunnel
  rides that direction. **No listening socket is added to the cabinet, ever, and no third-party tunnel agent
  (cloudflared, Tailscale, ngrok or similar) is installed on it.** The agent must keep working with no internet access and
  no inbound port.
- **Nothing outside the catalog.** The session carries a capability the agent's compiled catalog already defines, plus a
  read-only stream of the agent's own diagnostic output. It is not a way to run anything else, and the server never parses
  or interprets what the operator sends.
- **Never anonymous, never shared.** A session is opened by one identified operator, on one cabinet, and every session is
  audited: who, which cabinet, when it opened and closed, why, and what was run. Use the console's existing step-up
  mechanism — `consumeStepUpToken` as named in Revision 2 above — the same way rollouts and enrollment approvals use it.
- **Bounded and killable.** An idle timeout, a maximum session length, one live session per cabinet, a small fleet-wide
  cap, and a way to end any session from the console. A session that ends must free the cabinet immediately.
- **Visible.** A session shows in the console while it is live, and the cabinet records it locally, so an on-site engineer
  can tell that someone is on the machine.

## The job

Work in this order. If the run cannot finish, stop at a point where the tree builds and the tests you added pass, and say
in your report which of the six is outstanding — build passed, tests green, nothing half-applied.

1. **The relay.** Add the transport that lets the console and an agent exchange bytes, agent-initiated over the existing
   mTLS agent connection. Extend `agent/src/Cabinet.Agent.Core/Server/AgentConnection.cs` and the agent routes in
   `server/src/agent-api/server.ts`. Prefer reusing the existing long poll if it can carry an interactive session honestly;
   if the latency cannot be met, add a dedicated streamed route in the same style, under the same client-certificate
   requirement and the same rate-limit buckets as the other fleet routes. Frames carry bytes and nothing else: the server
   does not parse what an operator sends.
2. **Opening and closing.** A `session.open` command from the server (the command envelope in `docs/spec/03-protocol.md`)
   carries the session id and kind. The agent refuses when the local policy forbids it, when a session is already live, or
   when the certificate is not valid. Closing is explicit from either side, and also on idle. Every state change is an
   audit row and a server-side session record.
3. **The capability on top — no shell.** Two things, and nothing else:
   - **A live read-only stream of the agent's own diagnostic output**, so the owner can watch a machine fail: the agent's
     own log lines as they are written, the diagnostic records and health the agent already sends, and the broker's record
     of the live session. Bounded to the data the agent already owns — no reading of arbitrary paths, never the CUBEX
     database and never the Windows Security log (`docs/spec/11-security-review-brief.md:31`).
   - **The cabinet's existing catalogued operations, run inside the session** — restart a service, restart the agent, set a
     named operation going — each validated as it is today (`docs/spec/04-agent-spec.md:33`, catalog in
     `agent/src/Cabinet.Agent.Contracts/Catalog.cs`), each with its own audit row and its own step-up. The session gives
     the operator one place to watch and act; it does not widen what may be acted on.
   Do **not** add a shell, a script runner, a generic run-a-command path, or a general file transfer (revision 3 above).
   If you judge that even this is too wide, say so in the decision entry and implement the narrower thing you can defend.
4. **The console surface.** A page under the cabinet (`console/src/pages/cabinet/`) that lists live sessions, starts one
   behind the existing permission **and** a step-up token, streams the transcript, and ends the session. Follow the
   console's existing idiom for pages, permissions and step-up; do not invent a new auth path. A role without the permission
   must be refused by the server, not merely hidden in the UI.
5. **Install enables it.** `agent/install/Install-CabinetAgent.ps1` writes the agent configuration that allows sessions,
   with a local switch to turn it off on a cabinet, and the agent honouring that switch. The local record of a session must
   survive the session. The agent's read-only mode (`docs/spec/04-agent-spec.md:22`) must keep refusing everything this
   feature can do.
6. **Prove it.** At minimum, tests that: a session cannot start without a step-up token; a session cannot start for a role
   without the permission; the audit row and session record are written on open and on close; an idle session ends by
   itself; the agent refuses when its local policy is off; a second session on the same cabinet is refused; **the agent
   opens no listening socket** — assert that the cabinet's port set is unchanged while a session is live; and **the
   session cannot carry anything outside the catalog** — a name that is not in the catalog is refused, and the relay has
   no path that executes what it is sent.

## Rules that are not negotiable

- Nothing in this feature may work if the cabinet's local policy is off, or if the operator's step-up is missing.
- No hidden channel, no credential harvesting, no bypass of the console's session and role checks, no path that skips the
  audit. If a design choice would not survive the security review of `docs/spec/11-security-review-brief.md`, it is wrong.
- Do not weaken a test assertion to fit. Do not delete another feature's test to make room. If an existing assertion has to
  change, say which one and why in your report.
- Copy the suite's own command from the repository; the server suite is `npm test` in `server/` (`npm run build && node --test
  --test-concurrency=2 dist/test/*.test.js`, `server/package.json:12`) and needs `TEST_DATABASE_ADMIN_URL` exported; the
  console suite is `npm test` in `console/` (`node --test test/*.test.ts`, `console/package.json:11`). Never hand-roll a
  test invocation.
- Red/green only, and no non-zero exit hidden. What the sandbox cannot do (SQL Server on `127.0.0.1:11433`, Windows-only
  agent paths, a real cabinet) must be named with the exact command the reviewer should run, never faked.
- The agent stays `net10.0-windows` and keeps publishing both `win-x64` and `win-x86`.
- **Do not commit.** Leave the change in the working tree; the reviewer reads the whole diff first and commits.
- **Files you may add.** Source, schema, migration, configuration and test files are the run's to add and change as the
  work requires — a new operation means a new `contracts/schemas/operations/<name>.schema.json` beside its neighbours, and
  whatever the console, the agent or the installer needs. Generated build output is expected too. What you must not
  create is a report, a log, a scratch note, or any file outside this repository: your final message is the report, and
  the sandbox cannot write outside the repo anyway.

## Not in this task

- **A general remote shell, a script runner, or a run-anything capability.** The spec forbids it (revision 3, quoted
  above). If the owner decides he wants it, that is a change to `02-security-model.md:13` and
  `11-security-review-brief.md:29` first, and a separate task.
- The separately-briefed update-signing work (`docs/codex-tasks/updates-without-a-purchase.md`) — if you need its signing
  step, assume it lands separately and do not duplicate it.
- The cross-module write paydown.

## If the brief is wrong

If existing behaviour has to change, or the spec does not answer something, **stop and report rather than guessing**. A
stop is a finding, not a failed run: name the file and line that contradicts the brief.

# Session lifecycle, records and audit (F22, phase 2)

**Branch:** `feat/remote-access-tunnel` (off `main`; do not work on `main`). Phase 1 of
`docs/codex-tasks/remote-access-tunnel.md` is on this branch and is described below.

**Owner's instruction (2026-11-15):** the operator must be able to reach any machine the agent runs on, whatever network it
is on, to find out why it failed and fix it. A general shell is forbidden by the spec
(`docs/spec/02-security-model.md:13`, `docs/spec/11-security-review-brief.md:29`) and is out of scope; the capability the
spec allows is phase 3. **This phase builds the thing that makes the transport safe to switch on at all: the durable,
audited session record that every access is checked against.** Without it the transport must stay dead — and today it is.

## What already exists on this branch (read it; do not re-do it, do not restyle it)

Phase 1 landed a working relay and nothing more, all of it inert:

- `server/src/agent-api/session-relay.ts` — transport only. `authorize(cabinetId, sessionId)` is injected and consulted on
  **every** exchange; a failed authorize deletes the queue **and its buffered frames**; 16 KiB per frame each way; 16 queued
  frames each way then `429 relay_backpressure`; at most 16 live queue keys fleet-wide then `503 relay_capacity`; `close()`
  frees. Review decisions to keep: never drop or overwrite a frame silently; a revoked session's buffered bytes are
  destroyed; the transport's caps stay independent of the session service's caps (defence in depth).
- `server/src/agent-api/server.ts` (~line 659) — `POST /agent/v1/sessions/:sessionId/frames`, which returns **404 while no
  relay is installed** (fails closed), 413 over the frame limit, and maps `RelayError` to its status plus `retry-after`.
- `contracts/schemas/envelopes/session-frame.schema.json` with `contracts/examples/envelopes/session-frame/`
  (`valid/bytes.json`, `invalid/operation.json`) — `additionalProperties: false`, so a frame carrying an `operation` field
  is refused by the contract. That is deliberate: it is the reason this transport can never carry an execution.
- `agent/src/Cabinet.Agent.Core/Server/AgentApiClient.cs` — `ExchangeSessionFrameAsync`, an outbound POST only, 16 KiB
  bounded both ways. Nothing calls it yet.
- `server/test/session-relay.test.ts` (4 tests) and `agent/tests/Cabinet.Agent.Core.Tests/SessionTransportTests.cs`, which
  snapshots the machine's active TCP listeners before and after a frame and asserts they are unchanged.

## The job for this phase: the record that every access is checked against

1. **The durable session record.** A table (with its migration, in the repository's existing style) holding: session id,
   cabinet id, the operator who opened it, the kind, why it was opened, opened-at, last-seen-at, closed-at, how it ended
   (explicit, idle, killed, error), and the reason recorded on close. One row per session, never deleted by this feature.
2. **The audited transitions.** Every state change writes an audit row through the repository's existing audit path: opened,
   each command or frame exchanged is **not** audited individually (that is the transcript's job and it would drown the
   audit), but opened, closed, killed, refused and the reason are. Name in the report which existing audit helper you used.
3. **Who may open, and how it is proven - decided, do not choose it yourself: D98.** Read `docs/platform/decision-log.md` D98;
it is the authority here and it was revised after the first attempt at this brief. In short:
   - **Permission is a grant, never a rank.** Add migration `0035_user_permissions.sql` with
     `user_permissions (id, user_id, permission, scope_kind, scope_id, granted_by, granted_at, removed_at, removed_by)`,
     `scope_kind IN ('fleet','site','cabinet')` (`fleet` leaves `scope_id` NULL), unique per `(user_id, permission, scope_kind,
     scope_id)` over live rows, FK to `users`, and `DENY DELETE` to `cabinet_app` - revocation is `removed_at`, as `sites`
     already retires rows (`server/src/services/admin.ts:21`). Include the validation test and the real-schema test for it.
   - **The check is against the cabinet**: a `fleet` grant, or a `site` grant for that cabinet's site, or a `cabinet` grant for
     that cabinet. A grant scoped elsewhere is refused. `ROLE_RANK` is **not** consulted on this path and `admin` gets no
     implicit session permission.
   - Then, and only then, `consumeStepUpToken(db, token, userId, "session.open", target)` (`server/src/auth/stepup.ts:37`), the
     token taken from the body and wrapped as `server/src/console-api/admin-routes.ts:21` does. A grant says who may; the code
     says this operator, now.
   - `session.open` is a catalog entry with `kind: "write"`, `confirm: "code"`, `expirySeconds: 120`, `rateClass: "write"`, and
     **no `safetyNet`** (a session has no rollback net).
   - Audit actions: `session.open`, `session.end`, `session.kill`, `session.refused` - one row per transition, never per frame -
     and the same for each grant and revocation you add.
4. **The bounds, all of them enforced server-side and tested.** One live session per cabinet; an idle timeout; a maximum
   session length; a small fleet-wide cap; and an operator-issued end from the console that frees the cabinet immediately
   (the relay's `close()` already exists for this). A cabinet must not be able to hold a session open past the maximum by
   exchanging frames.
5. **Opening on the cabinet.** The server sends the `session.open` command over the agent's existing command channel (the
   envelope in `docs/spec/03-protocol.md`), carrying the session id and kind. The agent refuses when its **local policy**
   forbids sessions, when a session is already live on that cabinet, or when its certificate is not valid, and it reports
   the refusal. The agent also writes the session to its **local record**, which must survive the session and be readable
   by the on-site engineer (phase 3 gives it somewhere to surface; a durable file is enough here).
6. **Wire it up, still fail-closed.** Construct the relay in the server's composition root and pass in an `authorize` that
   reads the record (existence, not closed, not idle-expired, cabinet matches). The route must keep returning 404 while the
   feature is switched off on the server side — the switch is the record's own existence and the permission, not a new flag
   invented here.

## Prove it

At minimum, and named in your report with the command that ran each one:

- A session cannot start without a step-up token; cannot start without a matching grant; and cannot start for a grant
  scoped to another site or another cabinet (D98).
- Opening writes the audit row and the record; closing writes the close row and stamps the reason; killing writes its own.
- An idle session ends by itself, and a session cannot be held past the maximum by exchanging frames.
- A second live session on the same cabinet is refused.
- The agent refuses when its local policy is off, and reports that refusal rather than failing silently.
- A closed or revoked session's next exchange is refused by `authorize` and its buffered frames are gone.
- The authorization path is exercised against the **real** schema and the real table, not a mocked repository.

## Environment (verified on this host)

- `dotnet` is off the default PATH: `export PATH=$HOME/.dotnet:$PATH` first. `dotnet build agent/Cabinet.Agent.sln -c Release`
  then succeeds (verified: 0 warnings, 0 errors).
- SQL Server for the server suite listens on `127.0.0.1:11433`; `TEST_DATABASE_ADMIN_URL` is exported by the gate script at
  line 7 (`/home/marco/.hermes/scripts/gate-run.sh`) and you do not have it: write the tests, run what you can, and name the
  server suite in your report as the reviewer's command. A missing binary is this section, not the brief being wrong.
- The suite commands are the repository's own: `npm --prefix server test`, `npm --prefix console test`,
  `npm --prefix contracts test`, and `dotnet test agent/tests/Cabinet.Agent.Core.Tests/Cabinet.Agent.Core.Tests.csproj -c Release`.
  Note the directory is `agent/tests/`, not `agent/test/`.

## Rules that are not negotiable

- Nothing works when the cabinet's local policy is off, or when the operator's step-up is missing.
- No shell, no script runner, no arbitrary command, no general file transfer (phase 3 defines the capability;
  `docs/spec/02-security-model.md:13`). No hidden channel, no credential harvesting, no bypass of the console's session and
  role checks, no path that skips the audit.
- Do not weaken a test assertion to fit, and do not delete another feature's test to make room. If an assertion has to
  change, name it and say why.
- Red/green only, no non-zero exit hidden. What you cannot run here must be named with the exact reviewer command.
- The agent stays `net10.0-windows` and keeps publishing both `win-x64` and `win-x86`.
- **Files you may add.** Source, schema, migration, configuration and test files are yours to add. Generated build output
  is expected. Do not create reports, logs, scratch notes, or any file outside this repository: your final message is the
  report. **Do not commit** — leave the change in the working tree for review.

## Revision 2 amendments, from the adversarial review of phase 1 (2026-11-15)

The review's bottom line was that no path in `06a9754b` lets the server run anything outside the agent's compiled
catalog and that the agent opens no listener - the inert claim holds. Three items change phase 2 before it builds on
that interface.

- **F1, and it changes the design: the frame is not a pipe.** `contracts/schemas/envelopes/session-frame.schema.json`
  permits `data` to be any 0-16384 bytes, so the claim that a frame can never carry an operation holds by absence of a
  consumer, not by construction, and `server/src/agent-api/session-relay.ts:5` states it in a comment rather than
  enforcing it. Make the direction carry the meaning: **server to agent frames are control only** - open, close, keep
  alive, with no free-text payload - and **agent to server frames carry the diagnostic output**. A capability arrives
  as a catalogued operation with its own allowlist entry and its own audit row, never as bytes the agent interprets.
  `docs/spec/02-security-model.md:11` ("the server cannot add operations; only a signed agent upgrade can") and `:13`
  ("no shell, no script runner, no general file transfer and no way to run an arbitrary file") are the reason. Do not
  add an escape hatch for convenience, and do not answer this by tightening a comment.
- **F6, a defect in what already shipped: `authorize()` can throw.** It is a database call in the phase-2 path, and
  `session-relay.ts:16` destroys the queue and the buffered frames only when it returns `false`. A throw must take the
  same path, and a test must drive the throwing case, not only the `false` one.
- **F7: no constant retry hint.** The relay answers `retry-after: 1` while the server's own backoff is randomised over
  30-90 s. Use the server's figure or omit the header, and say which in a comment where it is set.

## If the brief is wrong

Stop and report rather than guessing: name the file and line that contradicts the brief. A stop is a finding, not a failed
run. Phase 1's first three attempts stopped for exactly this reason and every stop was worth more than the code that
followed it.

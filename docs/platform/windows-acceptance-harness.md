# Windows acceptance harness constraints

The development shell acceptance driver is `scripts/acceptance/session-shell.mjs`.
These constraints came from failed real-cabinet runs:

- Treat roughly 8191 characters as the command-line ceiling on this Windows SSH
  path (the underlying Win32 CreateProcess limit is higher). UTF-16 base64 and
  nested encoded commands expand payloads quickly. Stage payloads with SCP and
  invoke PowerShell with `-NoProfile -ExecutionPolicy Bypass -File`. The agent
  launcher reads its executable and arguments from its own staged JSON file;
  both SSH and CIM carry only a short script path, never an encoded supervisor.
- Processes started inside an SSH session can be killed when that session ends.
  Start anything that must survive through detached WMI/CIM process creation.
  Check agent survival in a separate SSH call one second after launch. Retain
  the process handle in the supervisor to capture the exit code.
- A development certificate hierarchy must contain a self-signed CA. Hand the
  agent that CA and serve the full leaf-to-CA chain;
  incomplete or incorrectly rooted chains fail with `SEC_E_UNTRUSTED_ROOT`.
  Keep certificate validation enabled; do not introduce a skip-validation flag.
- A wait that reports only “timed out” is a harness defect. Print `agent.log`,
  `run.out`, and `run.err` on timeout, along with the in-process server’s cumulative
  shed/error counters, shed reasons, and pool wait/queue state. Fail fast on unexpected agent exit and
  report its exit code and process state. On SSH failure, include the complete
  command and every argument so command-length and quoting failures are visible.

- Certificate **shape is a contract with the agent, not a preference**. The
  platform CA in `platform-ca.pem` must be the leaf's direct, self-signed issuer:
  exactly two tiers, with no intermediate CA. `AgentApiClient` builds its own
  `X509Chain` from the presented leaf alone, adds only the pinned platform CA to
  `CustomTrustStore`, and requires the built chain to end at that CA. The server
  must still present its complete available chain and validation stays enabled.
  This also constrains the real platform: introducing an intermediate under the
  platform root would stop every agent enrolling. Such a change must be paired
  with an agent that accepts a supplied chain.

From the repository root, the local regression check is:

```sh
node --test scripts/acceptance/session-shell-cabinet.test.mjs
```

The exact reviewer command for recorded real-cabinet acceptance is:

```sh
node scripts/acceptance/session-shell.mjs
```

Run on `feat/remote-access-tunnel` with `TEST_DATABASE_ADMIN_URL` already exported,
.NET available under `$HOME/.dotnet`, and SSH/SCP access to `deviceb` through
`$HOME/.ssh/config`. `SHELL_CABINET_SSH` overrides the cabinet alias;
`SHELL_PLATFORM_HOST` supplies a cabinet-reachable platform address when automatic
Tailscale discovery is unavailable, and `SHELL_PLATFORM_PORT` defaults to 18443.
The driver builds the current tree, creates an isolated database retained for
review, and stages a temporary agent on the cabinet. Local mocked regression
checks cannot prove Windows detachment, certificate trust, or end-to-end shell
acceptance; those require the reviewer command against the cabinet.

The cabinet harness uses a separate one-connection application-role pool for its
queries and service calls, leaving the API pool to the server. Both pools close
on exit; the database remains available for review. No admission gate or production
threshold is lifted. The optional `onAdmissionShed` observer reports the gate that
fired (including enrollment-status source rate, database wait/queue, or event-loop
lag); it does not change the response or admission decision. Server logging is enabled.

The harness must yield while SSH/SCP and other children run. Synchronous SSH
process checks every 250 ms block the same event loop that serves the API and
completes database acquisitions. A separate observer pool alone cannot prevent
that starvation. The cabinet runner now awaits asynchronous child processes,
including launch, survival checks, shutdown, uploads and failure-log collection.
The outer driver may block waiting for its child because it does not host the API.

The actual `overloaded()` inputs are API pool `waitMs > maxAcquireWaitMs`
(default 1000 ms), API pool `pending > maxPendingAcquires * 5` (default 100),
or `lagSeconds >= 3`: consecutive one-second p99 event-loop samples exceeding
`maxEventLoopLagMs` (default 250 ms). An optional overload override takes precedence;
the acceptance does not supply one. Severe overload uses multipliers 5 and 10,
and six lag samples. Every `until()` timeout prints cumulative shed counts,
shed reasons, API and observer pool state, and a server-supplied snapshot of
these exact load inputs, thresholds, decisions and reason (including
`below_all_load_thresholds`). The timeout regression asserts the printed output;
the child-process regression checks that server timers continue during a wait.

Production question for the maintainer (semantics unchanged): only
`GET /agent/v1/commands` converts shedding into HTTP 200 with
`reconnectAfterMs`. Other routes, including `POST /agent/v1/heartbeat` and
`GET /agent/v1/enroll/:requestId`, receive a hard HTTP 503. Sustained shedding
can prevent the heartbeats that keep presence and capabilities current, making
a cabinet appear offline, or prevent an agent from learning it was approved.
Should heartbeat and enrollment-status reads be sheltered from load shedding,
or should shedding be expressed to the agent in a form it can retry?

The repository uses GitHub issues. Filing this question was attempted through
the connected GitHub tool, but it returned “MCP tool call requires approval,
but approval policy is never”; no issue was created. Proposed issue title:
“Should heartbeat and enrollment-status reads be sheltered from load shedding
or receive a retryable shed response?”

Sandbox verification: the local regression and TypeScript build can run here.
`node scripts/acceptance/session-shell.mjs --probe` fails at SSH with
`socket: Operation not permitted` (exit 255); this sandbox cannot prove cabinet
survival, trust or recovery from the reconnect loop. Run the exact reviewer
command above outside this sandbox with the documented prerequisites.

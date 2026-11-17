# Operator shell: the third powershell.exe child in a session never starts

Supersedes the hypothesis in `session-shell-third-command.md` (still useful for the frame
evidence) and closes out `session-shell-partial-input-write.md` (partial writes ruled out:
the input stream is a FileStream over a CreatePipe handle, and anonymous-pipe writes are
not completed until all bytes are written).

## The measured phenomenon

Off-network, in one operator shell session on the real cabinet, with the platform's
container publishing 8443 and the agent connected over the public internet:

| command typed into the session | result |
|----|----|
| 1. `powershell.exe -NoProfile -NonInteractive -EncodedCommand <child-output check>` | ran, stdout **and** stderr returned |
| 2. `powershell.exe … <tailscale-state check>` | ran, marker returned |
| 3. `set /a 483+217` (plain cmd) | ran |
| 4. `set /a 631+109` (plain cmd) | ran |
| 5. `set /a 205+744` (plain cmd) | ran |
| 6. `powershell.exe … <whoami check>` | **delivered, echoed in one-to-three-character fragments, never ran** |

Latest failing run: `off-network-20261117-172754.log`; acceptance database
`cabinet_test_ca4967dbf1bc`. Earlier runs (`cabinet_test_5976622ba056`,
`cabinet_test_a07dd2c8414d`) show the same shape with **no** plain-cmd commands in between:
powershell #1 and #2 run, powershell #3 never does.

So: plain `cmd` built-ins run any number of times in one session, and the failure is
specific to spawning a `powershell.exe` child — the third one in a session is delivered to
the console and echoed, but never starts. The input reaches the console either way, so
this is about what launching a PowerShell child does to the session's console state (input
mode, input buffer, console handles, or job/process bookkeeping in our code) rather than
about the input path.

## What to do

1. Read `agent/src/Cabinet.Agent.Core/Server/LocalSessions.cs` and
   `agent/src/Cabinet.Agent.Windows/SessionTerminal.cs` and state what in **our** code
   differs between the second and third child, or, if nothing does, what PowerShell does to
   the console on exit that cmd.exe does not. Quote the lines you rely on.
2. **Build the repro as a runnable instrument, not a test**: a small console app under
   `agent/tools/` (follow the repo's naming and style) that creates the same pseudoconsole
   with the same bootstrap our agent uses, then types the same sequence — two encoded
   PowerShell children, three plain cmd lines, one more PowerShell child — printing every
   byte that comes back, with the child index against it. It must publish self-contained
   for Windows x64 (`dotnet publish -r win-x64 --self-contained`) because it has to run on
   the cabinet, where there is no SDK. It takes the bootstrap from the product code, so
   that changing the product changes the repro; do not copy the bootstrap by hand.
3. If the cause is ours, fix it in the agent and say which behaviour changed. If it is
   console or ConPTY behaviour we cannot change, propose the narrowest workaround that
   keeps the product honest — for example running the operator's commands in one long-lived
   child instead of one child per command — and say what that costs.

## Not in this task

- Do not change anything under `scripts/acceptance/`; the acceptance is the judge.
- Do not weaken, skip or re-scope any check. The failing check stays exactly as strict.
- Dev branch only: this stays on `feat/remote-access-tunnel`, never on `main`. The security
  posture on this branch may be relaxed where it buys a working instrument — but the
  product's release invariants (no shell or arbitrary-run path in a release build, no
  listening socket on the cabinet) must still hold in the code that would ship.
- No logs, reports or scratch files inside the repository. Your final message is the report.

## Environment, verified here

- The build on this host is clean: `dotnet build agent/src/Cabinet.Agent.Windows/Cabinet.Agent.Windows.csproj`
  (0 warnings). Publishing for Windows works from here too, including `--self-contained`.
- `dotnet test` **cannot execute** in your sandbox: it aborts with
  `SocketException (13): Permission denied`. Compiling is fine. Do not work around it; say
  so, and rely on the repro app and on me running things on the cabinet.
- Host test command that works outside your sandbox:
  `DOTNET_CLI_USE_MSBUILD_SERVER=0 dotnet test agent/tests/Cabinet.Agent.Core.Tests/Cabinet.Agent.Core.Tests.csproj --disable-build-servers -m:1`

# Operator shell: the third command in a session never runs

## Symptom (measured on the lab cabinet, off Tailscale, over the public IP)

In one operator shell session, the first two commands run and return their markers. The
third command's input is delivered to the agent, and the session then returns only
one-to-three character output fragments. The command never runs: neither its `DONE_`
marker nor its `FAIL_` marker ever appears, and the acceptance times out on
`off-network whoami`.

Timeline from `session_shell_frames` of the failing run, acceptance database
`cabinet_test_5976622ba056` (all times UTC, read out of the frame table):

| seq | direction | kind | what it carries |
|----|----|----|----|
| 9-10 | agent | `shell.out` | `#< CLIXML`, then `CHILD_STDOUT` / `CHILD_STDERR` / `DONE_f5c174548a6e42459568186a5fc0dd3b` — **command 1 ran and completed** |
| 11 | console | `shell.in` | command 2 (Tailscale-state check), delivered 12:00:46, 1011 chars, ends `\r` |
| 12-16 | agent | `shell.out` | `A`, an empty frame, `#< CLIXML`, `DONE_4c8afedfbab248ad90cba6b8bb3b613b`, then `<CR><LF>ecord"><AV>Preparing m/Objs><CR><LF>s>\Window` — **command 2 ran and completed**, plus its CLIXML progress text |
| 17 | console | `shell.in` | command 3 (whoami check), delivered 12:00:49, 1243 chars, payload complete |
| 18-22 | agent | `shell.out` | `H0A`, `gA`, `s`, an empty frame, `.` — one-to-three-character fragments, then nothing until the timeout |

The previous failing run (`cabinet_test_a07dd2c8414d`) shows the same shape in a different
session, and this run carried a 1.5 s wait before each command was typed, so the console's
input flush on child exit (which that wait was added for) is not the cause.

The run before this one shows the same shape with a different session id, and it was
reproduced with a 1.5 s wait inserted before each command was typed, so this is not the
console's input-flush race that the wait was added for.

## What is already true (do not re-do it)

- The agent's shell is a real ConPTY terminal and it returns a child's stdout **and**
  stderr: `CHILD_STDOUT` / `CHILD_STDERR` both arrived in frames 3-10 off-network. The
  ConPTY bootstrap fix (reopening the console devices) is in the tree and works.
- Input frames are delivered: frame 17 shows the third command's `shell.in` with
  `delivered_at` set, and its payload is complete (`…IABlAHgAaQB0ACAAMQAgAH0A\r`, i.e. the
  encoded script ending ` exit 1 }\r`).
- The transport is fine at this length: command 2 was 1011 characters and ran.

## The job

Find why the third `powershell.exe …` line typed into the same session never runs, and
fix the agent. Read first, and quote what you find:

- `agent/src/Cabinet.Agent.Windows/SessionTerminal.cs` — the ConPTY bootstrap and how a
  line of input is written to the pseudoconsole.
- `agent/src/Cabinet.Agent.Windows/LocalSessions.cs` — the session loop, `TryRead`, and
  how an incoming `shell.in` frame is handed to the terminal while a previously spawned
  child is still attached or exiting.

State the mechanism in your report: which handle or state the third write lands in, and
why the first two are accepted. If the cause is that the inner `cmd.exe` (or the console
input buffer) is left in a state that silently discards input after the second child
exits, the fix belongs in the agent, not in the acceptance script.

Add a Windows regression test in `agent/tests/Cabinet.Agent.Core.Tests/` that drives
three consecutive encoded commands through one session and asserts each one's marker comes
back, with the third one's marker provably its own (not echo-satisfiable). Follow the
existing `SessionShellTests.cs` pattern for the platform guard.

## Not in this task

- Do not change `scripts/acceptance/session-shell-cabinet.mjs` or any other file under
  `scripts/acceptance/`. The acceptance is the judge here, not the thing being fixed.
- Do not weaken, skip or re-scope any existing check. The failing check
  (`off-network whoami`) must stay exactly as strict.
- Do not add a shell or script-runner capability anywhere else, and do not touch `main`.
  This branch is `feat/remote-access-tunnel` and this work stays on it.
- Do not write logs, reports or scratch files inside the repository. Your final message is
  the report. Source, test, schema and configuration files the fix needs are yours to add.
- Your sandbox has no network and cannot reach the cabinet (`ssh` fails `socket: Operation
  not permitted`). The live off-network run is mine; say what you could not run.

## Environment, verified

- The .NET SDK is off-PATH at `/home/marco/.dotnet`:
  `export PATH="$HOME/.dotnet:$PATH"`.
- Build: `dotnet build agent/Cabinet.Agent.Windows/Cabinet.Agent.Windows.csproj`
- Test: `dotnet test agent/tests/Cabinet.Agent.Core.Tests/Cabinet.Agent.Core.Tests.csproj`
  (the Windows-only cases self-skip off Windows).
- Acceptance syntax check: `node --check scripts/acceptance/session-shell-cabinet.mjs`

## Acceptance block (paste the exact output)

```bash
cd /home/marco/cabinet_support_tool
export PATH="$HOME/.dotnet:$PATH"
node --check scripts/acceptance/session-shell-cabinet.mjs && echo "harness syntax OK"
dotnet build agent/Cabinet.Agent.Windows/Cabinet.Agent.Windows.csproj 2>&1 | tail -5
dotnet test agent/tests/Cabinet.Agent.Core.Tests/Cabinet.Agent.Core.Tests.csproj 2>&1 | tail -8
grep -c 'session-shell-cabinet' <(git status --short) || true   # expect 0: acceptance untouched
```

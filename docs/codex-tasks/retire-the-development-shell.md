# Retire the development shell

Revision 1. The console already refuses to open a shell; the server, the contracts and the agent still
carry the whole capability underneath. Remove it. Nothing user-visible changes: the diagnostic session
must behave exactly as it does now.

## What exists today (verified on `feat/remote-access-tunnel` @ `fdc0e3ac`)

The console's door is shut:

- `server/src/console-api/session-routes.ts:20` refuses `body.kind === "shell"` with
  `Refused("shell_unavailable", 400, "the development shell has been retired")`.
- `server/src/console-api/session-routes.ts:41` still reads `session_shell_commands` and
  `session_shell_frames` to build a session view.

The server still implements the capability behind that door:

- `server/src/services/session-opening.ts:15` types `kind` as `"diagnostic" | "shell"`.
- `server/src/services/session-opening.ts:26-31` — for `"shell"` it requires
  `cabinets.development_shell = 1`, refuses `shell_unavailable` otherwise, and audits `shell.authorized`.
- `server/src/services/session-shell.ts` — the `SessionShell` service.
- `server/src/agent-api/session-frame-route.ts:1` imports it, and `:19-20` dispatches every frame of a
  `kind === "shell"` session into it.

The agent ships the whole terminal stack:

- `agent/src/Cabinet.Agent.Core/Server/ISessionTerminal.cs`
- `agent/src/Cabinet.Agent.Windows/SessionTerminal.cs`
- `agent/src/Cabinet.Agent.Core/Server/LocalSessions.cs` — the shell branches
- `agent/src/Cabinet.Agent.Contracts/Local.cs` — the contract members that exist only for the shell
- It is inert only by wiring: `AgentConnection` constructs `LocalSessions` with no shell enabled and no
  terminal factory, so nothing ever opens one.

Tests, tools and examples that exist only for the shell:

- `agent/tests/Cabinet.Agent.Core.Tests/SessionShellTests.cs`
- `agent/tests/Cabinet.Agent.ShellCabinet/` (whole project)
- `agent/tools/Cabinet.Agent.SessionShellRepro/` (whole project)
- `contracts/examples/envelopes/session-control/valid/shell-{exit,input,resize}.json`
- `contracts/examples/envelopes/session-frame/valid/shell-{exit,output}.json`

Migrations, already applied to every database:

- `server/migrations/0036_development_shell.sql` added `cabinets.development_shell` and the shell tables
  unconditionally.
- `server/migrations/0037_shell_frame_utf8.sql`.

## The job

1. **Server.** Delete `server/src/services/session-shell.ts` and every reference to it. In
   `session-opening.ts`, drop `"shell"` from the `kind` union and delete the shell branch and its
   `shell.authorized` audit. In `session-frame-route.ts`, delete the shell dispatch and its import. In
   `console-api/session-routes.ts`, keep the refusal for an explicitly-requested shell (it is a
   user-facing answer, not a capability), and drop the shell tables from the session view.
2. **Contracts.** Remove `"shell"` from every session `kind` enum, delete the shell envelopes listed
   above, and regenerate anything generated from them. `contracts/generated/ts/contracts.d.ts` must end
   up regenerated, not hand-edited.
3. **Agent.** Delete `ISessionTerminal.cs`, `SessionTerminal.cs`, the shell branches in `LocalSessions.cs`
   and the shell-only members in `Contracts/Local.cs`. Where a shell argument is now unused, remove the
   argument rather than leaving it unwired. The diagnostic session's local handling must be unchanged.
4. **Tests and tools.** Delete `SessionShellTests.cs`, the `Cabinet.Agent.ShellCabinet` project (and its
   entry in the solution file) and the `Cabinet.Agent.SessionShellRepro` project. Delete the shell cases
   in any test that mixes them with other cases; leave the rest of that file working.

## Rules

- **No changes under `server/migrations/`.** The column and the tables stay in the databases. Name them
  in your report as work a separate, reviewed migration would have to do.
- **The development SSH transport is a lookalike and is out of scope.** Leave
  `DEVELOPMENT_SSH_TRANSPORT`, `ssh-transport-routes.ts`, `DevelopmentSshTransport.cs` and anything they
  touch exactly as they are. That surface is still wanted.
- The word "shell" also appears for PowerShell in eventlog, firewall and installer code. Those are not
  this task.
- `docs/spec` is the source of truth. If a spec sentence still claims a shell session exists, correct
  that sentence; otherwise do not edit docs.
- No log files, sweep output, scratch notes or `HANDOFF` files inside the repo. Your final message is
  the report.
- Do not merge `main` into this branch. Do not touch any other branch.

## Environment, verified

Run everything from the repo root, with the SDK on `PATH`:

```
export PATH="$PATH:/home/marco/.dotnet"   # dotnet 10.0.402 lives here, not on the default PATH
node --version   # v22.23.1
npm --version    # 10.9.8
```

`dotnet: command not found` (exit 127) means that export is missing. `Cabinet.Agent.Windows.Tests` is
Windows-only and cannot pass on this Linux box, so judge the agent suite by `Cabinet.Agent.Core.Tests`
alone: its baseline on this branch is **965 tests (963 passed, 1 failed, 1 skipped)**, and
`SessionShellTests.cs` contributes 9 of them. Expect 956 after the removal, and expect the same single
pre-existing failure — a new failure is yours.

## Acceptance

Run these and paste the exact output:

```
cd /home/marco/cabinet_support_tool
echo "--- the shell is gone from the code"
grep -rniE "sessionshell|isessionterminal|sessionterminal|development_shell|session_shell_(commands|frames)|shell\.authorized" \
  server/src console/src contracts agent/src agent/tests agent/tools \
  | grep -v node_modules || echo "CLEAN: no shell capability left in server/src, console/src, contracts, agent"
echo "--- the files are gone"
for f in server/src/services/session-shell.ts agent/src/Cabinet.Agent.Core/Server/ISessionTerminal.cs \
         agent/src/Cabinet.Agent.Windows/SessionTerminal.cs agent/tests/Cabinet.Agent.Core.Tests/SessionShellTests.cs; do
  test -e "$f" && echo "STILL PRESENT: $f" || echo "removed: $f"
done
echo "--- the diagnostic session is untouched"
grep -n '"diagnostic"' server/src/services/session-opening.ts
echo "--- the SSH transport is untouched"
git diff --stat origin/feat/remote-access-tunnel -- \
  $(git ls-files | grep -iE "ssh-transport|DevelopmentSsh") | tail -3
echo "--- migrations untouched"
git diff --name-only origin/feat/remote-access-tunnel -- server/migrations/ | tail -3
echo "--- builds and tests"
cd server    && npm run build 2>&1 | tail -3
cd ../console && npm run build 2>&1 | tail -3
cd ../agent  && dotnet build Cabinet.Agent.sln -c Release 2>&1 | tail -5
```

Report, in this order: what you deleted, the before/after counts of the test suites you touched, exact
output of the acceptance block, and anything you deliberately did not do.

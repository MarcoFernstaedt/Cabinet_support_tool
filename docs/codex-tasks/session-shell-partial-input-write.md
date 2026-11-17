# Operator shell: prove or kill the partial-input-write hypothesis

Follow-up to `session-shell-third-command.md`. Read that first: two commands run in one
off-network session and the third is delivered (`shell.in` with `delivered_at` set,
payload complete) but only echoes back one-to-three-character base64 fragments and never
runs — no `DONE_`, no `FAIL_`, no output.

## The hypothesis to test

`agent/src/Cabinet.Agent.Core/Server/LocalSessions.cs` writes shell input with a single
call:

```csharp
await terminal.Input.WriteAsync(bytes, token).ConfigureAwait(false);
await terminal.Input.FlushAsync(token).ConfigureAwait(false);
```

If that write completes short — the pipe accepts fewer bytes than asked — the tail of the
line never reaches the console. The tail is the trailing `\r`, so `cmd.exe` echoes the
characters it did receive, sits waiting for Enter, and never executes the command. That
matches every observed frame: fragments of echoed base64, then silence, with no marker of
either kind.

I could not establish this from the source alone and you could not either, so do not
write a fix on the strength of it. Test it first.

## What to do

1. Find out what `terminal.Input` actually is (the concrete stream type) and whether a
   short write is possible on it. Quote the type and the reason, not a guess.
2. Write the deterministic test: a stream double whose `WriteAsync` accepts at most a few
   bytes per call, then assert the full line — **including the trailing `\r`** — arrives
   in order. Put it in `agent/tests/Cabinet.Agent.Core.Tests/`, following the existing
   `SessionShellTests.cs` pattern, and it must not be Windows-gated if it can run anywhere.
3. Add the three-consecutive-commands case from the earlier brief to the same file if it
   is not already there, using markers that echo cannot satisfy.
4. If the hypothesis holds, fix it in the agent — write the whole buffer in a loop and
   only then flush, or use a write path that guarantees all bytes. If it does not hold,
   say so plainly, leave the code alone, and report what you ruled out and how.

## Not in this task

- Do not change anything under `scripts/acceptance/`. The acceptance is the judge.
- Do not weaken, skip or re-scope any check; `off-network whoami` stays exactly as strict.
- This work stays on `feat/remote-access-tunnel`. Never touch `main`.
- No logs, reports or scratch files inside the repository. Your final message is the
  report: the mechanism, the evidence, and what you could not run (your sandbox has no
  sockets, so `dotnet test` cannot start — say so rather than working around it).

## Environment

- SDK off-PATH: `export PATH="$HOME/.dotnet:$PATH"`.
- The Windows project builds clean with 0 warnings: `dotnet build agent/src/Cabinet.Agent.Windows/Cabinet.Agent.Windows.csproj`
- Host test command that works: `DOTNET_CLI_USE_MSBUILD_SERVER=0 dotnet test agent/tests/Cabinet.Agent.Core.Tests/Cabinet.Agent.Core.Tests.csproj --disable-build-servers -m:1`
- Acceptance syntax: `node --check scripts/acceptance/session-shell-cabinet.mjs`

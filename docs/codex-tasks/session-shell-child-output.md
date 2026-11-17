# Task: the operator shell never surfaces a child process's output

Branch: `feat/remote-access-tunnel` (dev branch only — never rebase onto or merge into `main`).

Your sandbox has no network and no SSH, so you **cannot** reach the lab cabinet: find the defect by reading
the code, fix it, and say plainly what you could not run. I run the acceptance on the host afterwards — do
not edit `scripts/acceptance/run-off-network-vps.sh` or the harness's assertions, and do not touch
`.staging/`.

## The defect, measured

A session opens, the console types a command into the ConPTY, and the command's output never comes back as
`shell.out` frames. The frame dump is staged at `.staging/shell-off-network-frames.txt`. In order: ConPTY
init; clear screen + title; the resize taking effect (30 rows); **the typed command echoed verbatim** (1012
chars); title `... cmd.exe - powershell.exe  -NoProfile -NonInteractive -EncodedCommand <952-char token>`;
title back to plain `cmd.exe`. No script output, no completion, nothing.

The harness now fails earlier and more precisely, on `first child process output` (see the commit that adds
it): a session must return a child's `Write-Output` **stdout** and `[Console]::Error.WriteLine` **stderr**
before any state check runs. That check is the pass/fail for this task.

## Already ruled out by direct measurement — don't redo these

- **Truncation**: the echoed command is byte-for-byte the typed one (same 952-char token).
- **The script**: extracted from the frame and run over SSH on the same cabinet, it prints as designed.
- **A hang**: with the Tailscale service stopped, `tailscale status --json` returns in 4.7s (exit 1).
- **The session transport and the frame writer**: the ConPTY's *own* output (init, clear, resize, titles,
  echo) all arrive as `shell.out`, so writes and reads work. The loss is between the child process's stdout
  and the pseudoconsole.

## Where to look (paths verified against the tree)

- `agent/src/Cabinet.Agent.Windows/SessionTerminal.cs` — `CreatePseudoConsole` (120×30), the `CreatePipe`
  pair, `Output = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read, 4096, false)`, and
  the drain-on-close comment at `:85-92`. Check what the spawned process's standard handles actually point
  at, and whether the pseudoconsole is wired to the child the way ConPTY requires.
- `agent/src/Cabinet.Agent.Core/Server/LocalSessions.cs:112` — the outgoing path:
  `if (_output.Reader.TryRead(out byte[]? bytes)) { ... kind = "shell.out" ... }`, and the frame exchange at
  `:133`. Find what fills that bounded queue, what happens when it is empty, and whether output written
  between polls can be dropped (a queue that is drained only on a successful read, or a pump that is not
  running for the first poll, both lose exactly this output).

## Constraints

- The console's contract: if a command returns, its output comes back. A command that never returns may
  produce no output — that is not this defect.
- The shell stays off by default, and the platform keeps refusing anything it has not been allowed to run.
- No new dependency; follow the existing patterns in the agent.
- Do not commit; leave the changes in the working tree and state the mechanism you found in your summary.

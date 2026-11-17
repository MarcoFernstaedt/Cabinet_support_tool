# Task: the operator shell never surfaces a child process's output

Branch: `feat/remote-access-tunnel` (dev branch only — never rebase onto or merge into `main`).
Reproduce on the lab cabinet `ssh deviceb` (Windows HP). Do not weaken the acceptance to make it pass.

## Symptom (measured, not inferred)

`bash scripts/acceptance/run-off-network-vps.sh` now reaches past the off-network reconnect — the
container-published 8443 fix works, the agent reconnects from off the tailnet. It then fails at
`shell verifies Tailscale stopped` with a 120s timeout: the session's first command returns **no output
at all**.

Evidence: the full frame dump is staged in this repo at `.staging/shell-off-network-frames.txt` (git-ignored).
It is a decoded transcript of `session_shell_frames` from the run's test database (that database is not reachable
from your sandbox, so the dump is the evidence — read it rather than querying SQL).

The session's frames, in order, are:

1. `shell.resize` then `shell.in` (console side).
2. `shell.out` `ESC[?9001h ESC[?1004h` — ConPTY init.
3. `shell.out` clear screen + title `Administrator: C:\windows\system32\cmd.exe`.
4. `shell.out` 30 × `ESC[K` + `ESC[H` — the resize taking effect.
5. `shell.out` — **the typed command echoed verbatim** (1012 chars).
6. `shell.out` — title `... cmd.exe - powershell.exe  -NoProfile -NonInteractive -EncodedCommand <952-char token>`.
7. `shell.out` — title back to plain `cmd.exe`.

Nothing from the script ever appears: no output, no `DONE_`, no `FAIL_`.

## What is already ruled out (each checked directly)

- **Truncation**: the echoed token is byte-for-byte the typed one (`echoed includes typed: true`), same 952 chars.
- **The script itself**: extracted from the frame and run on the same cabinet over SSH, it runs and prints
  (`DONE_...` / `FAIL_...`) as designed.
- **A hang**: with the Tailscale service stopped, `tailscale status --json` returns in **4.7s** (exit 1), so
  the command cannot be blocking for 120s.
- **The reader**: the agent's frames for the ConPTY's *own* output (init, clear, resize, titles, echo) all
  arrive, so the session transport and `shell.out` writes work.

So the loss is between **the child process's stdout** and the pseudoconsole — the script ran (the title
shows `cmd.exe - powershell.exe ...`) and produced nothing on the console.

## Your job

1. Find why a child process's stdout never reaches the session's `shell.out` frames. Start at
   `agent/src/Cabinet.Agent.Windows/SessionTerminal.cs` (133 lines: `CreatePseudoConsole`, `outputRead`
   FileStream, the drain-on-close comment) and the session transport that writes frames
   (`agent/src/Cabinet.Agent.Core`, `server/src/services/session-shell.ts`). Treat the console's own
   output as the contract: if a command runs, its output comes back.
2. Reproduce it on `deviceb` (a second acceptance run is ~12 minutes; the off-network path now gets all the
   way to this step).
3. Fix it in the agent, not in the acceptance. Keep the console's behaviour: a command that never returns
   may produce no output, but a command that returns must.
4. Add a regression check to the committed acceptance (no hand-typed verification): a first command whose
   output must come back before the state check.
5. Second, smaller defect on the same run: the off-network restore path. The agent's shell runs as
   **SYSTEM**, and `tailscale down/up` as SYSTEM fails with `the target profile does not belong to the
   user` — so "restore Tailscale through the shell" as written cannot work. `Start-Service Tailscale` as
   SYSTEM **does** restore it (verified: `svc after start: Running`, `state after start: Running`). Make
   the restore path use something that is proven to work from the account that runs it, with a bounded
   timeout, and keep the existing scheduled-task safety net.

Constraint: the shell stays off by default and the platform keeps refusing commands it has not been
allowed to run. Evidence for the PR: the frame dump above, plus your reproduction log.

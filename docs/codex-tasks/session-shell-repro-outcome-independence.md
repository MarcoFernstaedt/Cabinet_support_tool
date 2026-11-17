# Session-shell repro: a failing command must not stop the sequence, and a child must flush before it exits

Two measured facts, both from runs on the real cabinet (`C:\repro\repro-driver.log`,
2026-11-17 16:17 and 16:21, driver `cabinet-repro-driver.ps1`):

## 1. A PowerShell child that exits from a catch loses the tail of its output

| child | how it exited | marker (last line of the typed wrapper) |
|----|----|----|
| line=1 | normally, `exit 0` | `DONE_ca9b3bbf…` **arrived**, `COMPLETED` at 3285 ms |
| line=2 | from `catch`, `exit 1` | `DONE_6d2fe62d…` **never arrived**; the throw message came back truncated mid-sentence (` not go down`), then the console was silent for 74 s |

So "delivered, echoed, no marker" is not proof a command never ran. That is how the
acceptance currently reads it (`Timed out: off-network whoami`), and the same signature —
input echoed in fragments, no `DONE_`/`FAIL_` marker — is what produced the whole
"third command never runs" investigation. **The acceptance may be reporting output loss as
non-execution.**

## 2. The repro's sequence stops at the first failing command

The instrument sends six commands; the second asserts the node is Stopped. In the 16:21 run
the node *was* Stopped (`node down; BackendState=Stopped`) and the second command still threw,
because `tailscale status --json` itself fails when the node is down. The runner then stopped
and commands 3-6 (three plain `cmd` lines, then one more PowerShell child) were never sent.
**The instrument can only answer its own question when no earlier command fails.**

## What to change

1. **Make each command's outcome independent.** A command that throws must not stop the
   sequence: record its result, continue, and report all six at the end. The point is to
   observe what happens to the *third PowerShell child*, which is impossible if the run
   aborts earlier. Include a command that is *expected* to fail, so the failing path is
   exercised deliberately rather than by accident.
2. **Make the wrapper flush before it exits.** Every path — success and catch — must flush
   its output and settle briefly before exiting, so a normal command's marker cannot be lost
   with the dying child. If flushing does not fix it, say so with the bytes that prove it.
3. **Make the question answerable without the node's state**: the assertion about Tailscale
   should tolerate a down node (report what it sees) instead of throwing.
4. Then state the finding for the third PowerShell child with the frame evidence: did it
   start, what came back, and does the child index match the bytes.

## Not in this task

- Do not weaken, skip, or re-scope any acceptance check. If the acceptance misreads output
  loss as non-execution, propose the harness-side fix that distinguishes them, and say which
  signal proves which.
- Keep the product's release invariants (no shell or arbitrary-run path in a release build,
  no listening socket on the cabinet). Dev branch only: `feat/remote-access-tunnel`, never main.
- The repro publishes self-contained for win-x64; I run it on the cabinet over SSH. Your
  sandbox cannot execute tests (`SocketException (13)`), so validate by compiling and publishing.
- Do not commit. Leave changes in the working tree.

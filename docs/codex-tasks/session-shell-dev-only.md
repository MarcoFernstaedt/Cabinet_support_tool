# Task: an operator shell over the session transport, development branch only

**Who builds it:** Codex CLI, on `feat/remote-access-tunnel`. On Marco's direction the split is by branch: **Codex
builds on the lab development branch, Claude works on `main`.** This is not a task for `main`, and not for any branch
cut from it. It also starts only after item 6 of `docs/codex-tasks/remote-access-tunnel-lifecycle.md` composes the
relay - there is no transport to carry a shell before that.

**Marco's direction (2026-11-15):** "For shell I want you to get full shell access and this is only on second branch -
whatever you send it this never goes on main, this is strictly only used in development, never touched main."

## What this is, stated plainly

A full interactive shell from the platform to a cabinet's agent, so an engineer can use a cabinet the way he uses a
machine he has ssh to: run a command, read the output, see the hardware. It exists on `feat/remote-access-tunnel` and
nowhere else. The shell and the tunnel are one branch's business whatever else they are: the tunnel is the transport,
the shell is a capability that rides it, and both live here and never on `main`.

**Why we want it, in Marco's words:** so the platform can "look around the cabinet to find things and see if we can add
them". The shell is how we learn what a machine exposes; a typed operation with its own allowlist entry and its own
audit row is how any of it ships to `main`. D100 keeps that route open, and this branch does not replace it.

## Why the branch matters more than the feature

`docs/spec/02-security-model.md:13` promises *"There is no shell, no script runner, no general file transfer and no way
to run an arbitrary file"*, and `docs/spec/11-security-review-brief.md:29` repeats it under "What the platform cannot
do". That promise is why a customer lets this agent run as SYSTEM on their cabinet, and it is what the compiled catalog,
the release signing and the step-up codes exist to keep. The shell is worth having for our own fleet and our own
diagnostics; it is not worth changing that promise. Keeping it on this branch is what lets both be true, and it is why
D100 says the same thing in the decision log.

## The job

1. **A distinct frame kind, not a general pipe.** The session frame stays control-only in its read-only mode
   (revision 2 of `docs/codex-tasks/remote-access-tunnel-lifecycle.md`). The shell adds its own named kinds -
   `shell.in`, `shell.out`, `shell.resize`, `shell.exit` - so a reader of the schema sees a shell rather than "bytes".
   Never generalise the frame to make this easier.
2. **Off unless configured on purpose.** The agent serves it only when its configuration names it: a key absent from
   every shipped release and absent from the release packing script. The server offers it only for a cabinet whose
   agent reported the capability. A build without the key behaves exactly as today - the endpoints refuse, the console
   hides the entry, and the refusal is audited.
3. **Audited, both directions.** Each session opens an audit row through the existing `audit()` helper
   (`server/src/db/db.ts`) with the cabinet, the operator and the consumed step-up token, and each command line is
   written to the session record as it arrives rather than at the end: a shell that dies must still leave what was run.
4. **A process, not a script runner.** The agent starts a shell process and pipes to it. It does not evaluate a string,
   does not write a file and execute it, and does not accept a path to run. This is the difference between an operator
   tool and a backdoor, and it is the only reason this is acceptable on our own estate at all.
5. **A console surface that says what it is.** A banner naming it development-only, no history beyond the session, and
   the session's record linked from the cabinet page so a later reader can see what was done.
6. **The tests this repository expects:** the endpoints refuse when the agent did not report the capability; a session
   leaves an audit row and a command log even when the process dies; a frame kind the agent does not serve is refused
   rather than handed to the process; and a release build - configuration without the key - cannot reach any of it.

## Not in this task

- **No change to `main`, ever, by this branch.** Do not merge `main` into it for convenience unless a conflict makes
  the work impossible, and if that happens, say so in the report.
- No removal or loosening of the read-only stream's control-only shape.
- No shell on any path that is not the tunnel's own session transport: not over the console API, not as a general
  endpoint on the agent's HTTP API.

## Acceptance

The four tests above, and a recorded session on `deviceb` showing a command's output, its audit row and its session
record - with Tailscale off, which is the requirement the tunnel exists for.

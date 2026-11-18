# Acceptance: verify a spawned child's effect without relying on console attribution

Measured on the cabinet with `--repeat 20 5` (`C:\repro\repeat.log`, 2026-11-18T00:02Z):

```
TALLY requested=20 delivered=0 startedWithoutOutcome=20 unconfirmed=0 notSent=0
TRACE child=11 before-write pid=19840 utc=2026-11-18T00:02:18.4132607Z
TRACE child=11 after-flush utc=2026-11-18T00:02:18.4224205Z      <- 9 ms later
SUMMARY line=12 child=12 status=OUTPUT_TIMEOUT verdict=started without outcome
```

Elapsed 5 s per child is the repeat mode's per-child ceiling; `before-write` and `after-flush` are
written through a file independent of ConPTY, so they prove the script ran and its managed write
returned. **Twenty of twenty children ran and wrote, and none of their output reached the console.**
In the same sessions, plain `cmd` built-ins complete in ~30 ms and their output arrives every time
(`done=700`, `done=740`, `done=949`). So the console keeps emitting for the shell itself and stops
attributing output for a spawned descendant.

The `START_` marker work already did its job: this is now *reported* correctly rather than misread as
non-execution. `5acb470f` ("bind a descendant's stdout and stderr to the console") exists precisely
because that attribution is unreliable, and it is not reliably holding.

## What to change

The acceptance must not depend on a spawned child's stdout reaching the console, because that is the
thing under test and it is not reliable. Verify each check's **effect** out of band instead:

1. Each wrapped check writes its result to a file on the cabinet (a fixed path, unique per check id),
   and the *typed* command's console output is used only as a hint, never as the assertion.
2. The runner reads those files over SSH after the check (it already has an SSH session to the
   cabinet) and asserts on their contents. A check whose file is absent is a real failure; a check
   whose file is present passes on its own evidence, with the console result recorded alongside.
3. Keep every existing assertion's *meaning*: the same commands, the same expectations. Only the
   channel the result arrives through changes.
4. Report per check: file evidence, console marker state, and the verdict — so a red run says which
   channel failed.

If you judge console attribution can be made reliable instead, say so with the mechanism and the
evidence — but do not leave the acceptance asserting on a channel this measurement shows is silent.

## Not in this task

- Do not touch the agent's product code; this is the acceptance's channel, and the finding above is
  about the console, not the platform's logic.
- Dev branch only: `feat/remote-access-tunnel`, never `main`. Do not commit; leave changes in the tree.
- Sandbox cannot execute tests (`SocketException (13)`); validate by syntax/mocks and say so.

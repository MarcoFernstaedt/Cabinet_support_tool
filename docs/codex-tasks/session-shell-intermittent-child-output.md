# Intermittent loss of a spawned child's console output

The `START_` marker work did its job: the acceptance now *positively* reports the class.
Latest off-network run (evidence `/home/marco/cabinet-audit/lab64/off-network-20261117-234512.log`,
database `cabinet_test_16048fde2949`):

```
first child process output: execution unconfirmed
{"sessionShellCommands":[{"label":"first child process output","id":"54c6bc90…","startReceived":false,"outcome":null,"result":"execution unconfirmed"}]}
```

## What is established

- **The input is not the problem.** The repro logs `IN bytes=<n>` followed by `INPUT_FLUSHED` for every
  command, including the ones whose output never appears.
- **It is not a command-count limit.** Three plain `cmd` lines in one session complete in ~30 ms each,
  every time, in the same session as the failures.
- **It is not the platform.** Server diagnostics at failure: `"counts":[]`, `"shedReasons":{}`,
  `obsemaPool.pending: 0`, `pool.pending: 0`. Nothing shed, nothing pending.
- **It is intermittent and it is not limited to a repeated child.** In the repro run of 16:35 the first
  PowerShell child delivered `START_` and `DONE_` (1675-byte input); the second (3091 bytes, an expected
  failure) and the third (2175 bytes) delivered **no marker at all**. In the acceptance run of 23:45 the
  **first** child delivered nothing.
- **The loss can take the child's first line.** `START_` is printed and flushed before any work. Its
  absence means no byte from that child reached the console — not a truncated tail.

Measured frame shapes, for reference:

```
1565ms line=1 child=1 IN bytes=1675 start=START_d18c26f0… done=DONE_d18c26f0… ; INPUT_FLUSHED
73089ms line=2 child=2 IN bytes=3091 … expectFailure=True ; INPUT_FLUSHED ; RESULT code=1 (no marker)
144624ms line=3 child=0 IN bytes=15 done=700 ; COMPLETED at 144655ms      <- plain cmd, fine
149234ms line=6 child=3 IN bytes=2175 start=START_e11df222… ; INPUT_FLUSHED ; RESULT code=1 (no marker)
```

## Where to look

Commit `5acb470f` ("bind a descendant's stdout and stderr to the console") changed how a spawned
child's output is captured. A capture path that has to keep reading after the direct child exits —
and that can miss bytes when the console's reader and the child's teardown overlap — is the shape
this evidence points at. Read that change against the current capture code and say what it does on
the console handles, quoting the lines.

## What to do

1. **Add a repeat mode to the repro** (`agent/tools/Cabinet.Agent.SessionShellRepro`): run N identical
   PowerShell children back to back, one marker each, and print a per-run verdict — delivered, started
   without outcome, or unconfirmed — plus the tally. This turns "sometimes" into a rate, which is what
   a fix has to move. Keep the existing sequence intact as one of its modes; do not remove it.
2. **State the mechanism** from the code with quoted lines, and name the smallest fix that makes a
   child's output reliable. If the capture path is the cause, fix it there.
3. If you cannot establish it from the code, say exactly which observation would settle it and make the
   repro produce it. Do not guess and do not paper over the loss.

## Not in this task

- Do not weaken, skip or re-scope any acceptance check. It is correctly reporting the defect now.
- Do not touch `scripts/acceptance/session-shell-cabinet.mjs` beyond what a correct fix requires; it is
  the judge.
- Product release invariants stand (no shell or arbitrary-run path in a release build, no listening
  socket on the cabinet). Dev branch only: `feat/remote-access-tunnel`, never `main`.
- Your sandbox cannot execute tests (`SocketException (13)`). Compile and publish for win-x64; I run it
  on the cabinet. Do not commit; leave changes in the working tree.

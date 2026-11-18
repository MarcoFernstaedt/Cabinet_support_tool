# The acceptance aborts on retired shell checks, and the cleanup error hides it

The SSH transport is built but was never exercised. The evidence proves it rather than suggesting it.

## What the retained database shows (`cabinet_test_dd00de39ac88`)

```
remote_sessions:            (no rows)
audit_log, newest first:    enrollment.approve | succeeded | cabinet ...
                            enrollment.submit  | succeeded | enrollment ...
                            token.create       | succeeded | token ...
```

Enrollment completed and then **nothing happened**: no transport open, no session, no down-cycle, no new
audit row of any kind. So the run aborted after enrollment and before it ever reached the transport.

The log confirms where, in the harness's own words from the earlier run:

```
Waiting for scheduled fallback before SSH cleanup after failed off-network proof
```

**The off-network proof that failed is the retired console shell.** Its checks are still in
`session-shell-cabinet.mjs`, the shell is retired (correctly, on the operator's SSH directive), so those
checks now fail and the harness aborts before the transport checks run. The transport code is
therefore untested by the very acceptance written to prove it.

## The second defect: the cleanup error replaced the real one

The reported failure was:

```
Error: Fallback cleanup could not reach cabinet: ssh failed (1): ...
throw 'Fallback task still registered'
```

The machine's state is in fact correct: `node=Running`, `fallbackTask=0`, `hold=False`. The task *had*
been unregistered; the verifier then found it absent and threw, which is a race/idempotency bug in the
cleanup. Because that throw happens after the primary failure, **the acceptance reports the cleanup
error instead of the real reason it failed** — the primary failure never appears in the log at all.
That is worse than the bug: a red run that names the wrong cause is how this whole investigation
started.

## What to do

1. **Remove the retired shell's checks** from the acceptance. Keep the enrollment proof, the
   reachability preflight, the down-cycle and the restore. The acceptance must exercise the SSH
   transport — the thing it exists to prove — and must not abort on a retired feature.
2. **Make the fallback cleanup idempotent.** Re-read `fallbackTask=0`/`hold=False` as the expected
   state: an already-removed task is success, not a failure. Guard the unregister, then verify with a
   re-read, and treat absence as success.
3. **Never let a cleanup error replace a primary failure.** Report the primary outcome first, and the
   cleanup result as an additional line. If both fail, both appear, primary first.
4. Then the transport checks must run and produce `remote_sessions` rows and transport audit rows.
   That is the evidence this task is judged on.

## Not in this task

- Do not re-add anything from the console shell.
- Re-run the static free-identifier check and the no-machine pass on any script you touch.
- Sandbox cannot execute tests (`SocketException (13)`); compile and validate, do not claim live
  verification. Do not commit; leave changes in the working tree. Dev branch only.

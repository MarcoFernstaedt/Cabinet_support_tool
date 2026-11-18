# The SSH transport works; take the node down out of band

## What the stage labels proved

The acceptance now runs the whole path, and the transport is real:

```
stage: reset pre-drop platform connections
stage: wait for public agent reconnect
stage: open SSH transport
stage: run command through SSH transport
stage: verify SSH audit events and closed session     <- no failure; it moved on
```

```
POST /api/cabinets/<id>/ssh-transport   -> 400   (step-up required)
POST /api/cabinets/<id>/ssh-transport   -> 200   (approved)
```

The transport opened behind the step-up gate, a command ran through it, and the audit events and the
closed session verified. That is the tunnel working. Keep it working.

## The remaining failure: the down step kills its own connection

```
stage: take Tailscale down
tailscale down SSH result: ssh failed (255): Command failed: ssh ... deviceb ...
```

`ssh ... deviceb` reaches the cabinet **over Tailscale**. `tailscale down` therefore tears down the very
connection that is issuing it, ssh exits 255, and the down script never wrote its pre-recovery evidence.
The fallback then restored the node, so the evidence file reads `Running`, and the harness correctly
fails its assertion `Cabinet file must record Tailscale stopped before recovery`. The assertion is right
and must stay - it caught a real problem rather than a formatting one.

## What to do

1. **Never issue the down over a connection that rides the tailnet.** Two acceptable instruments:
   - the **platform's own SSH transport** (deliberately designed to survive the node going away), or
   - a **scheduled task on the cabinet** that runs the down and its evidence write in the user's
     context, queued before the node drops.
   `Start-Process` detached over SSH does not survive the session ending and must not be used.
2. **Write the evidence file before the node drops, inside the same instrument.** The file must record
   the observed state at the moment it is written, and the down and the write must not be two separate
   round trips over the connection that is about to die.
3. **A failed down must fail the run immediately.** The harness logged `ssh failed (255)` and carried
   on to the next stage; it should stop there, because everything after it (the transport proof, the
   cleanup assertion) is then measuring something other than off-tailnet behaviour.
4. Then re-run and confirm: the evidence file records `Stopped` pre-recovery, the transport opens and
   runs a command while the node is down, the `remote_sessions` row matches transport, cabinet and
   operator, and both audit events are present.

## Not in this task

- Do not change the transport's access control, the platform networking, the release agent, or the
  cleanup's idempotency - all of that is working.
- Do not relax the `Cabinet file must record Tailscale stopped before recovery` assertion.
- Re-run the static free-identifier check and the no-machine pass on any script you touch.
- Sandbox cannot execute tests (`socket: Operation not permitted`); compile and validate, do not claim
  live verification. Do not commit; leave changes in the working tree. Dev branch only.

# Host networking removed the platform's reachability from the cabinet

The off-network acceptance times out at `cabinet enrollment`, and the agent's own log says it five times:

```
--- agent.log ---
Enrollment: The platform server did not answer in time.   (x5)
```

The server did start — it logs `Server listening at https://<host>:8443`, and the harness's own observer
queries against it succeed (the `--- server diagnostics ---` line is populated). So the platform is up
and reachable **from this host**, and unreachable **from the cabinet**. That is the signature of the
change you made in this task, not of an application fault.

## The cause

`session-shell-cabinet.mjs:246` now starts the platform with `--network host`, and `:185` listens on
`0.0.0.0:8443`. On this VPS, **TCP 8443 is reachable from the internet only because Docker publishes
it**: the bridge network's published port installs the DNAT rule that lets the traffic in. Docker's
published-port path also exempts that traffic from the host's own input filtering. A container on
`--network host` has neither, so the cabinet's packets to the public address are dropped before they
reach the process — which is why the agent retries five times and gives up, while the host's own
queries to `127.0.0.1` succeed. The runs that enrolled (bridge plus `-p 8443:8443`) worked for exactly
this reason, and it is the only networking difference in this change.

You moved to host networking because the harness needs the host's `ssh` client to reach the
platform's assigned loopback SSH endpoint. That need is real; meeting it this way is not.

## What to do

1. **Put the platform back on the bridge network with a published port** — the arrangement the earlier
   off-network runs enrolled with. Keep listening on `0.0.0.0:8443` inside the container; publish it
   as before so the DNAT rule exists.
2. **Meet the SSH client's need by publishing a loopback range** instead: publish the endpoint ports
   the transport assigns (for example a small range such as `127.0.0.1:19000-19099` in the same
   published-port style), so the host's `ssh` reaches them without host networking. Bind those
   endpoints to loopback only.
3. **Add a reachability preflight**: before the enrollment deadline starts, the runner must prove the
   cabinet can reach the platform address and port, and fail with that fact in the log if it cannot.
   Minutes spent on an enrollment timeout while the actual fault is one layer down is the failure
   this acceptance exists to prevent. If host networking is genuinely required for some part, prove
   it with a probe rather than assuming it.

## Not in this task

- Do not change the platform's own listen configuration, the transport, or the release agent.
- Re-run the static free-identifier check and the no-machine pass over any script you touch — the
  last run died mid-way on a free variable that a syntax check passed.
- Sandbox cannot execute tests (`SocketException (13)`); compile and validate, do not claim live
  verification. Do not commit; leave changes in the working tree. Dev branch only.

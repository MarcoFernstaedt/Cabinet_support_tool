# The tunnel is SSH. Carry a real SSH session over the agent; retire the console shell.

Operator directive, verbatim: **"SSH is how this tunnel should work no other way."**

The console-shell work (session terminal, ConPTY, PowerShell children, marker plumbing) is
**superseded**. Do not extend it. The tunnel is a real SSH session on the cabinet, and nothing
else. Where a machine can join the tailnet, plain `ssh <host>` already satisfies this and needs
no platform involvement. The product work is for the machines that cannot: the agent must carry
SSH outbound so a cabinet on any network is reachable with an ordinary SSH client.

## Target outcome

From the platform, an operator gets a **real SSH session** into a specific cabinet — the kind of
session you get from `ssh user@host`, not a command-and-poll abstraction:

1. The agent, on an authenticated console request, opens an **outbound stream** to the platform
   over its **existing mTLS connection**. The cabinet makes no inbound connection and binds no
   listening socket — that invariant stands.
2. The platform binds that stream to a **local TCP endpoint** that speaks SSH, so an ordinary
   client works: `ssh -p <assigned-port> <cabinet-user>@127.0.0.1`. The console may additionally
   offer a browser SSH client, but a real `ssh` binary must work — that is the test of "SSH".
3. Closing the session tears the stream down and revokes the endpoint.

## Shape and security

- **A narrow, typed, allowlisted operation**, not a generic port-forward primitive. Name it for
  what it is (an SSH transport to one cabinet), give it its own allowlist entry, and give it its
  own audit row on **open and close**, with the requesting user, cabinet, and endpoint. A generic
  "forward an arbitrary port" path is explicitly out of scope and must not exist.
- **Config-gated and off by default**, dev branch only. Release builds must not advertise it.
  `docs/spec` says there is no shell and no way to run arbitrary files; this is a dev-only
  capability on `feat/remote-access-tunnel`, and the spec must say so in those words rather than
  contradict it silently.
- Record the decision: this supersedes the operator-shell decision. Note that the dev shell's
  repeated-PowerShell-child output loss (a pseudoconsole attribution problem, measured 20 of 20)
  is a reason it was the wrong vehicle, not a bug to fix.

## Also in this task

- Update `docs/spec` where it describes remote access, and the decision record, so the spec and
  the code agree. A reader must not find the old shell described as the tunnel.
- Retire the console shell path from the console UI and its dev config, keeping only what the
  off-network enrollment proof still uses. Do not delete the acceptance's enrollment checks.
- Add an acceptance that proves the SSH path end to end, off network: a real SSH client, a real
  command on the cabinet, a real result, with evidence that the cabinet side made an outbound
  connection only. Follow the existing evidence rules — file evidence read out of band, no
  assertion on a spawned child's console output.

## Not in this task

- Do not spend effort on the console-shell output loss. It is diagnosed; the vehicle is wrong.
- Sandbox cannot execute tests (`SocketException (13)`); compile, do not claim live verification.
- Do not commit; leave changes in the working tree. Dev branch only: `feat/remote-access-tunnel`.

# Resolve the SSH transport: the cabinet already has an SSH server

Follow-up to `docs/codex-tasks/ssh-transport-tunnel.md`. You left one decision open: which SSH
server can consume the agent's mTLS byte stream, run commands under the cabinet account, and bind
no cabinet listener. Win32 OpenSSH's lack of inetd mode made the obvious answer look blocked.

**It is not blocked. Do not implement an SSH server.**

## What is already true

The cabinet runs Windows OpenSSH `sshd` and it already works: `ssh deviceb` from this host connects
to it over Tailscale and returns results in a second. That is the SSH server. There is no need for a
new one in .NET, no inetd, and no new protocol implementation anywhere.

## The transport that is needed

1. A console request opens a **typed, fixed-target transport**: a stream to **the cabinet's own SSH
   server on `127.0.0.1:22`**. Not a caller-supplied host and port - a named operation ("SSH
   transport to cabinet X") whose target is fixed at the loopback SSH endpoint. This is what keeps it
   a narrow typed operation rather than a generic port-forward primitive, and it must be implemented
   that way: one allowlist entry, one audit row on open and close, no way to name a different
   destination.
2. The agent opens the connection **outbound** to the platform over its existing mTLS stream and
   pipes bytes in both directions. Nothing new listens on the cabinet.
3. The platform binds a **local TCP endpoint** and forwards it to that stream, so an ordinary client
   works: `ssh -p <assigned-port> <cabinet-user>@127.0.0.1`. Authentication, host keys, algorithms
   and the session itself are all the cabinet's real `sshd` doing real SSH - nothing reimplemented.
4. Closing tears the stream down and revokes the endpoint.

## Record the honest position in the spec

`docs/spec` says there is no shell and no way to run arbitrary files, and the cabinet runs no
listening socket. An SSH transport means the cabinet's **existing loopback SSH server** carries an
authenticated session, so the spec must state exactly that rather than claim the cabinet exposes no
service at all: the transport adds no listener, reaches only the loopback SSH endpoint that is
already installed, is config-gated, dev-only, allowlisted and audited. A reader must not be able to
find a claim the code contradicts.

## Evidence

The acceptance must prove the whole path off network with the real thing: `ssh` with a real key to
`127.0.0.1:<assigned-port>` while the cabinet is off the tailnet, one command run on the cabinet, its
result read back as file evidence out of band, and evidence that the cabinet side opened only an
outbound connection. Use the existing enrollment checks for the off-network proof rather than adding
a second way to do it.

## Not in this task

- No SSH server implementation, no inetd, no third-party SSH server dependency.
- Do not touch the retired console shell beyond keeping it retired.
- Sandbox cannot execute tests (SocketException 13); compile, do not claim live verification.
- Do not commit; leave changes in the working tree. Dev branch only: feat/remote-access-tunnel.

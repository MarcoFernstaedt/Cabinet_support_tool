# Task: off-network acceptance mode for the session-shell harness

Branch: `feat/remote-access-tunnel` (dev-only — never merge to `main`, never rebase onto `main`).
File to change: `scripts/acceptance/session-shell-cabinet.mjs` (plus its launcher/config helpers if needed).

## Why

The harness today proves the operator shell over the agent's own mTLS connection, but the cabinet
reaches the platform over the **tailnet**: `platformHost` defaults to this host's tailnet address and
the run records `transport: 'tailnet', offNetworkTested: false`. A cabinet on a customer network has
no tailnet, so the transport that matters is the **public one**. Marco's instruction: install the
agent on the HP, turn Tailscale **off**, prove remote access still works (`whoami`, desktop check, a
write + cleanup), then turn Tailscale back **on**.

Only one port on this host is reachable from the internet: TCP **8443** (published by
`cabinet-server-1`; the operator stops that container for the duration of the run so the harness can
bind it). The platform certificate must therefore carry a **public IP SAN**, which
`developmentPlatformPki(work, [platformHost])` already supports when `SHELL_PLATFORM_HOST` is an IP.

## Required behaviour

Add an off-network mode, driven entirely by environment variables, defaulting to today's behaviour:

- `SHELL_OFF_NETWORK=1` — enable the mode. Everything below only happens when it is set.
- `SHELL_PLATFORM_HOST=<public address>` and `SHELL_PLATFORM_PORT=8443` — the agent must be told to
  reach the platform at the public address, and the platform API must listen on that port.

Steps, in this order:

1. **Baseline while the tailnet is up.** Enroll and start the agent exactly as today. Assert the
   agent is connected *before* the tailnet goes down, so a later reconnect is attributable to the
   public path and not to a stale connection.
2. **Fallback that always restores the machine.** Before dropping the tailnet, register a Windows
   scheduled task on the cabinet (`cabinet-acceptance-tailscale-restore`, one-shot, ~6 minutes out)
   that runs `tailscale up`. This is the safety net: if the harness or the shell dies, the cabinet
   comes back by itself. The task must be removed on every exit path, including failure.
3. **Drop the tailnet.** Over SSH, run `tailscale down` (use the absolute path
   `C:\Program Files\Tailscale\tailscale.exe`). This is the last SSH action of the off-network
   window: after it, no step may depend on SSH, on the tailnet address, or on MagicDNS.
4. **Prove the connection is public.** Poll the platform only (database + agent API + notification
   feed, no SSH) until the agent reconnects. Record the **peer address the agent API observes for
   the cabinet's connection** and assert it is not a tailnet address (`100.64.0.0/10`) — that is the
   evidence that the path is the internet, not the tailnet. Fail loudly if the reconnect never
   happens.
5. **Drive the shell off-network.** Open a session and run, in order:
   - `whoami` — assert the output names the cabinet's machine account;
   - a desktop listing (`Get-ChildItem $env:USERPROFILE\Desktop`) — assert it returns entries;
   - a write **and** its cleanup: create a marker file on the desktop, assert it exists, delete it
     and assert it is gone. This is the "check the desktop and clean it" step; it must not touch or
     delete anything that was already there.
6. **Restore the tailnet through the shell itself.** Run `tailscale up` over the platform session
   (not SSH) and assert the shell reports success, then wait for SSH to answer again and delete the
   fallback scheduled task. Turning the cabinet's own connectivity back on through the operator shell
   is part of the proof.
7. **Record honest evidence.** The final JSON line gains the transport actually used and the
   off-network facts — e.g.
   `{ database, cabinetId, sessionId, transport: 'public', offNetworkTested: true, platformHost,
   platformPort, peerAddress, tailnetDownAt, tailnetRestoredAt }`.
   `offNetworkTested` may only be `true` when steps 3–6 all passed; if the tailnet never went down,
   or the reconnect was never observed, or the restore failed, the run must fail with a clear message
   rather than report success.
8. **Keep the tailnet path exactly as it is.** With `SHELL_OFF_NETWORK` unset the harness must behave
   as it does today: tailnet host by default, `transport: 'tailnet'`, `offNetworkTested: false`.

## Constraints

- Everything lives in the committed script — **no manual command is part of the acceptance run**.
- No new production default changes; nothing in `server/`, `console/` or `agent/` changes behaviour.
- Do not weaken certificate validation, do not add a flag that skips verification.
- `node --check scripts/acceptance/session-shell-cabinet.mjs` must pass.
- Leave the working tree ready for review: no commit, no push, `main` untouched.
- The run needs the live cabinet over SSH, so the *execution* is not yours — report the exact command
  and what a pass looks like. Do not claim a hardware result you did not run.

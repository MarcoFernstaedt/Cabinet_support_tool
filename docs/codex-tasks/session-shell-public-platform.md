# Off-network acceptance: the platform must be publicly reachable the way production is

## The constraint, measured on the VPS host (2026-11-17)

External reachability of the VPS comes **only from Docker publishing a container port**. Everything
else was measured and fails:

- **Docker-published port**: the cabinet reached the deployed container's published `8443` and got
  an answer. This is the path an installed cabinet uses, and it is the only one that works.
- **A plain host process listening on `0.0.0.0:8443`**: reachable from the host itself (loopback and
  via the public IP) but the **cabinet's connection times out**. Host listeners are not externally
  reachable.
- **A container that forwards to a host listener**: dead end. Container -> host traffic is dropped
  (every host address on the target port tested blocked), so a forwarder inside a bridge network
  cannot deliver to a listener on the host.
- **Tailscale Funnel raw TCP**: reaches the node's local target only from a tailnet client. An
  external client's connection arrives at the ingress and no bytes are delivered, so after
  `tailscale down` the agent cannot come back through it. This is why
  `fresh public agent reconnect after tailscale down` timed out.
- **MagicDNS while Tailscale is up** resolves the node's own name to its tailnet address, so the
  cabinet reaches the tailnet path first even when the agent is configured with a public name.

Conclusion: the acceptance platform must be reachable from the cabinet the same way the deployed
platform is, i.e. **it must be the thing that publishes the public port**.

## What to change (only `scripts/acceptance/session-shell-cabinet.mjs` and, if it helps,
## `scripts/acceptance/run-off-network-vps.sh`)

In off-network mode, serve the platform from a **container that publishes port 8443** instead of a
host listener behind an ingress:

- Build/run this branch's server as the container (the repository Dockerfile is the right base), with
  the acceptance test database and the harness's development PKI mounted in, publishing
  `8443:<container port>` on the host.
- Keep everything the harness already proves, unchanged in meaning: enrollment through the public
  address, an authenticated agent connection observed from the request (the agent's poll is
  long-lived), Tailscale dropped on the cabinet, the agent must reconnect over the public address,
  the peer the agent API sees must not be a tailnet or IPv4-mapped-tailnet address, the operator
  shell must run `whoami` plus a desktop listing plus a marker file write and its cleanup, Tailscale
  restored through the shell, SSH verified back, and the six-minute scheduled-task fallback removed
  on every exit path.
- The agent must be told to dial the **public IP** (`168.231.67.178`, from `SHELL_PLATFORM_HOST`),
  and the platform certificate issued for the run must carry that **IP SAN** — the deployed
  certificate already does this, so the PKI code path exists; do not weaken certificate
  verification anywhere, and do not add a flag that skips it.
- Bring the container down on every exit path, deploy or not: the deployed `cabinet-server-1` must
  be restarted afterwards and the port must be free at the end of the run.
- With `SHELL_OFF_NETWORK` unset, the harness must behave exactly as today.
- `node --check` must pass and the existing regression tests must stay green.

Leave the working tree **uncommitted** on `feat/remote-access-tunnel` for review. You cannot SSH to
the cabinet: do not claim a hardware result you did not produce.

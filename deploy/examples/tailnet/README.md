# Example: console through Tailscale, optional front on another domain

The generic deployment publishes the console on ports 80 and 443 and the agent API on 8443. This example keeps the agent API public (cabinets on customer networks must reach it) and moves the console behind Tailscale: Caddy answers on loopback only, Tailscale Serve or Funnel forwards to it, and a site on another domain can proxy `/console` to the Funnel address.

Nothing here is committed with real values. Copy the files and fill in your own:

```sh
cp deploy/examples/tailnet/compose.override.yaml deploy/compose.override.yaml
cp deploy/examples/tailnet/Caddyfile.local       deploy/Caddyfile.local
cat deploy/examples/tailnet/env.example >> deploy/.env    # then edit the <placeholders>
docker compose --project-directory deploy config          # check
docker compose --project-directory deploy up -d --build
```

| File | What it changes |
| --- | --- |
| `compose.override.yaml` | Caddy on `127.0.0.1` only, and mounts `Caddyfile.local` instead of `Caddyfile`. |
| `Caddyfile.local` | Serves the console under `/console-proxy` for the other site's rewrite, and sends a browser that reaches the front directly to `CONSOLE_PUBLIC_URL`. |
| `env.example` | `CONSOLE_ORIGIN`, `CONSOLE_PUBLIC_URL`, `AGENT_API_HOSTNAMES` with the public address first, and the development upgrade switch, commented out. |

Then point Tailscale at Caddy, for example `tailscale funnel --bg --https=10000 https+insecure://127.0.0.1:443`.

To turn it off: `rm deploy/compose.override.yaml deploy/Caddyfile.local`, remove the lines from `deploy/.env`, and run `docker compose --project-directory deploy up -d`.

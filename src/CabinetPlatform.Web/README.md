# Cabinet Support web Console

The browser Console for support staff and administrators. It opens on a **sign-in page**; every page after that needs a signed-in account on the Cabinet Server.

| Path | What it is |
|---|---|
| `console/console-server.mjs` | The Console server (backend-for-frontend): sign-in, sessions, security headers, Server route allowlist, Live/Demo modes |
| `console/demo-sandbox.mjs` | Sample fleet used by Demo mode, shown alongside real cabinets |
| `console/public/` | Browser app (no build step, no runtime dependencies) |
| `test/` | Console tests |
| `legacy-preview/` | The earlier loopback preview pages and static mock-up, kept for reference and still tested. Not the Console. |

## Run it

The quickest way is a ready-made script from the repository root:

- `tools/live/start-web-console-live.sh --tailscale` runs the real Server and Console for real Agents, such as the HP lab laptop. See [docs/live-agent-setup.md](../../docs/live-agent-setup.md).
- `tools/demo/start-web-console-demo.sh` runs everything on one machine with simulated agents.

To run the Console by hand against a running Server:

```text
cd src/CabinetPlatform.Web
npm ci
CONSOLE_UPSTREAM=http://127.0.0.1:5019 npm start
```

Open `http://127.0.0.1:4180` and sign in. The first administrator is `admin`. Its one-time password is set when the Server's database is created (the scripts above generate and print it), and you choose your own password at first sign-in. Administrators create everyone else's accounts under **Staff accounts**.

The full guide, role matrix, Live/Demo modes and security model are in [docs/web-console.md](../../docs/web-console.md).

## Test

```text
npm test
```

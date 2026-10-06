# Web Console

The web Console replaces the retired Windows (WPF) support console. It keeps the same workflow (fleet list, cabinet workspace with section tabs, approvals, staff and audit), adds a dashboard, site view, diagnostics activity, light/dark themes and a phone-width layout, and talks to the real Cabinet Server API.

Source: `src/CabinetPlatform.Web/console/` (server: `console-server.mjs`, browser app: `public/`). No build step and no runtime npm dependencies.

## Live and Demo modes

**Settings → Data source** switches each signed-in user between:

- **Live:** real cabinets and agents through the Cabinet Server. See [live Agent setup](live-agent-setup.md) to connect a real Windows PC such as the HP lab laptop.
- **Demo:** a built-in sample fleet (6 cabinets, 3 sites, pending enrollments, alerts, staff, event logs and process lists). Demo data is generated inside the Console for your session only. Approvals, new staff, diagnostics and alert notes made in Demo mode never reach the Server, its database or its audit log, and they vanish at sign-out. A banner and a "Demo data" badge stay on screen the whole time. The same role rules apply: support users still can't open administrator pages.

Set `CONSOLE_DEMO=disabled` to remove Demo mode from a Console.

## Quick start: full demo on one machine

Requirements: .NET 8 SDK and Node.js 20+.

```text
tools/demo/start-web-console-demo.sh
```

This is the full onboarding rehearsal against a real Server with simulated agents. (For a quick sample fleet, Demo mode in Settings needs no setup.) It builds and starts, all on loopback only:

| Process | Address | Notes |
|---|---|---|
| Cabinet Server (SQLite) | `http://127.0.0.1:5009` | Real Server, real authorization and audit |
| Web Console | `http://127.0.0.1:4180` | Open this in a browser |
| Simulated agents | — | Three synthetic cabinets speaking the real Agent protocol |

On first run it generates a JWT signing key, an agent key and a one-time administrator password, stores them in `~/.cabinet-console-demo/secrets.env` (mode 600) and prints the password. Options: `--reset` (wipe the demo database, secrets and agent identities), `--no-agents`, `--no-build`. Ctrl+C stops everything. Demo data persists between runs.

## Demo walkthrough

1. **Agent onboarding.** The simulated agents (`tools/demo-agent/demo-agent.mjs`) register with the Server as soon as it starts. Nothing is admitted automatically; each agent waits as a *pending registration*.
2. **Admin account onboarding.** Sign in as `admin` with the printed one-time password. The Console requires the administrator to set their own password before anything else is available (the Server enforces this too).
3. **Approval of cabinets.** Go to **Administration → Enrollment**. Each pending agent shows its hostname, machine ID, OS and agent version. **Approve…** assigns a display name, client, site, optional department and role (Sync, Satellite or Standalone) with an approval note that goes into the audit log. **Reject…** is permanent for that machine. Approved cabinets start sending inventory and heartbeats within seconds.
4. **Onboard the support team.** **Administration → Staff accounts → Add staff member** creates a Tier 1, Tier 2 or Administrator account with a generated temporary password. The new person must set their own password at first sign-in.
5. **Support team works the fleet.** Sign in as the support user. Dashboard, Cabinets, Sites, Alerts, Diagnostics and Audit log are available. In a cabinet, the tabs show Overview, Performance (24-hour trend charts), Processes, Services, Storage, Network, Updates, Events, System and Activity. **Run diagnostic** requests an observation-only action (process list, event log view, etc.); the simulated agent answers process-list and event-log requests and the result appears on the tab automatically.
6. **Administrators work the fleet too.** An administrator has every view and control a support user has, plus Enrollment, Staff accounts and cabinet administration (rename, change role, retire).

## Roles

| Capability | Support (Tier 1 / Tier 2) | Administrator (Supervisor) |
|---|---|---|
| Dashboard, cabinets, sites, cabinet tabs | ✓ | ✓ |
| Run observation-only diagnostics | ✓ | ✓ |
| Acknowledge / resolve connectivity alerts | ✓ | ✓ |
| Diagnostics activity, audit log | ✓ | ✓ |
| Approve / reject cabinet enrollment | — | ✓ |
| Create, edit, deactivate, unlock staff; revoke sessions | — | ✓ |
| Rename, change role, retire a cabinet | — | ✓ |

The Server's authorization policies are the authority. The Console hides controls a user cannot use and the BFF refuses administrator routes for support tiers before they reach the Server, but neither is relied on for security.

## Security model

- **No tokens in the browser.** The Console server (a backend-for-frontend) signs in to the Server on the user's behalf and keeps the access and refresh tokens in process memory. The browser gets only a random 256-bit session ID in an `HttpOnly`, `SameSite=Strict` cookie (`__Host-` prefixed and `Secure` when served over HTTPS). The server stores only its SHA-256 digest.
- **Session limits.** 30-minute idle timeout, 8-hour absolute limit, capped by the Server's refresh-token lifetime. Access tokens are refreshed server-side shortly before they expire. Sign-out deletes the session. Any Server 401 (password change, deactivation, role change or "sign out everywhere" by an administrator) ends the Console session immediately.
- **CSRF.** Every state-changing request needs the exact Console `Origin`, `Content-Type: application/json` and the per-session CSRF token in `X-CSRF-Token`. The session ID rotates after a password change.
- **Route allowlist.** Only the Server routes listed in `ROUTES` in `console-server.mjs` are reachable. Agent endpoints, elevated SQL and hardware-actuation grants, batches, successor and office enrollment endpoints are not exposed. Query parameters and request bodies are size-limited; only JSON is accepted.
- **XSS.** A strict Content-Security-Policy (`default-src 'none'; script-src 'self'; style-src 'self'`, no inline script or style) plus a UI that builds every element with DOM APIs and text nodes. Server data is never parsed as HTML.
- **Other headers.** `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP, `Permissions-Policy`, `Cache-Control: no-store`, HSTS over HTTPS.
- **Host pinning.** Requests whose `Host` does not match the configured public origin are refused (DNS-rebinding protection).
- **Sign-in.** Rate-limited per client (10/minute) in addition to the Server's own lockout and per-IP limit. Failures return a generic message that does not reveal whether an account exists or is locked.
- **Transport.** The Console refuses to listen on a non-loopback address without TLS and refuses a plaintext Server URL unless the Server is on loopback.
- **Errors.** Only an error's `title`, `detail` and validation messages are forwarded, size-limited. Stack traces and trace IDs are not.

Tests: `cd src/CabinetPlatform.Web && npm test` (see `test/console-server.test.mjs`). CI already runs this suite.

## Running against your own Server

For a real Agent on a Windows PC, `tools/live/start-web-console-live.sh --tailscale` sets all of this up. See [live Agent setup](live-agent-setup.md). To run the Console by hand:

```text
CONSOLE_UPSTREAM=https://cabinet-server.internal \
CONSOLE_PUBLIC_ORIGIN=https://support.example.org \
node src/CabinetPlatform.Web/console/console-server.mjs
```

| Variable | Default | Meaning |
|---|---|---|
| `CONSOLE_UPSTREAM` | (required) | Server origin. HTTPS, or HTTP only to loopback. |
| `CONSOLE_HOST` / `CONSOLE_PORT` | `127.0.0.1` / `4180` | Listen address. Non-loopback requires TLS. |
| `CONSOLE_PUBLIC_ORIGIN` | `http(s)://host:port` | Exact origin browsers use. Set it when behind an HTTPS reverse proxy. |
| `CONSOLE_TLS_CERT` / `CONSOLE_TLS_KEY` | — | PEM files to serve HTTPS directly. |
| `CONSOLE_DEMO` | `enabled` | `disabled` removes Demo mode. |
| `CONSOLE_AGENT_SERVER_URL` | — | HTTPS address Agents use for the Server; shown to administrators in Settings. |

Behind a reverse proxy (for example Tailscale Serve or an internal load balancer), bind the Console to `127.0.0.1`, terminate TLS at the proxy, preserve the `Host` header and set `CONSOLE_PUBLIC_ORIGIN` to the HTTPS URL.

## Before real customer data

The demo is safe to show with the bundled synthetic agents. These items from the [release gates](readiness.md) still apply before staff use it on real cabinets:

- **MFA.** Sign-in uses the Server's username and password. Production should sign in through the Entra boundary in `CabinetPlatform.WebHost` (see [web Console security](web-console-security.md)).
- **Single instance.** Sessions live in memory: a restart signs everyone out and the Console cannot be load-balanced without a shared session store.
- **Cabinet scope.** Any support user can see every cabinet, which matches the Server's current role-wide policy. Per-cabinet authorization is a Server change.
- **Native validation.** Windows Agent, browser accessibility (screen reader) and fleet-scale performance testing remain open.

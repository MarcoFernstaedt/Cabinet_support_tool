# Platform server

The Node 22 + TypeScript + Fastify server from docs/spec/05-server-spec.md. Everything in the spec is built (milestones 2 to 7):
- the database;
- the agent API with mutual TLS, enrollment, certificates, heartbeats and the long-poll command channel;
- the console API with sign-in, two-factor, roles, step-up and the console-managed settings, which serves the built console;
- issue types, symptom rules and the alerts engine: correlation, site-wide patterns, claims, Map to issue with Admin approval, rule history and rollback, and offline alerts;
- write commands with step-up, the write pause and per-user limits, the software library with its own package checks and two-person approval, package downloads, and the firewall change history (Milestone 5);
- administration (Milestone 6): accounts, presence, per-person activity, the audit log search and chain check, clients and sites, issue types and suppressions, fleet safety, settings, retention, and security alerts;
- signed agent upgrades (Milestone 7): the update store, staged rollouts and upgrade reports;
- device settings that follow the client (scanner hardware IDs and sync ports), and an 8,000-agent load test.

## What is here

| Path | Contents |
| --- | --- |
| `migrations/` | Versioned SQL, applied in order. An applied migration can never change; add a new one. |
| `src/db/` | Pool, transactions, the audit helper and chain verification, and the migration runner |
| `src/pki/` | A small DER codec, CSR checks and certificate issuing. All signing goes through `IssuingKey.signTbs`. |
| `src/services/` | The business logic, one file per area. Each takes a database handle, checks its own rules and writes its audit entries in the same transaction. Areas: enrollment, cabinets, commands, events, alerts and rules, writes, packages, releases and rollouts, users, administration, security alerts, settings and device settings, maintenance. |
| `src/agent-api/` | The agent listener: TLS terminated by Node, client certificates checked against the database on every request; the command notifier |
| `src/console-api/` | The console listener: sessions, guards (role and step-up), the live stream, and the routes by area |
| `src/auth/` | Passwords (Argon2id), authenticator codes (RFC 6238), sessions, step-up tokens, the secret box for authenticator secrets |
| `src/packages/` | The server's own package checks: zip, MSI (compound file), PE and catalog signatures, the trusted publisher list |
| `src/contracts.ts` | Ajv validators for every contract; nothing reads a body before one of these has checked it |
| `src/config.ts`, `src/runtime.ts`, `src/main.ts` | Environment configuration, keys and TLS, and the process that runs both listeners and the timed jobs |
| `src/cli.ts` | `platform-admin`, the operator tool on the server host (the same rules as the console, audited as "via cli") |
| `test/` | One test file per area, the browser end-to-end tests (`console-*-e2e.test.ts`), and `load/agents.ts` (the load test) |

## Configuration

Everything comes from environment variables (`src/config.ts`); secrets come from the environment or the secret store, never from files in the repository.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | (required) | The application's database login (a role holding only `cabinet_app`). |
| `DATABASE_OWNER_URL` | | The owner login, used only by `platform-admin migrate`. |
| `AGENT_API_HOST`, `AGENT_API_PORT` | `0.0.0.0`, `8443` | The agent API listener. |
| `AGENT_API_HOSTNAMES` | `localhost` | Comma-separated names the agent API's development certificate covers. |
| `AGENT_LONG_POLL_SECONDS` | `25` | How long a command poll is held (1 to 25). |
| `AGENT_TLS_CERT_FILE`, `AGENT_TLS_KEY_FILE` | | The agent API's TLS certificate and key in production. |
| `DEV_PKI_DIR` | | Development only: where a development issuing CA and TLS certificate are created and kept. |
| `PACKAGE_DIR`, `PACKAGE_MAX_MB` | `../data/packages`, `500` | The software library's store and size limit. |
| `RELEASE_DIR` | `../data/releases` | The update store for signed agent releases (500 MB per release). |
| `CONSOLE_ORIGIN`, `CONSOLE_SECRET_KEY`, `CONSOLE_HOST`, `CONSOLE_PORT`, `CONSOLE_STATIC_DIR`, `CONSOLE_TRUST_PROXY` | | The console listener; see [Console API](#console-api). |
| `PACKAGE_TRUST_DIR`, `UPGRADE_KEYS_DIR` | | Tests only: another trusted publisher list or release key folder. Both refuse to run when `NODE_ENV=production`. |
| `NODE_ENV` | | `production` in production. |

Tests also read `TEST_DATABASE_ADMIN_URL`, `TEST_AGENT_DLL` and `PLAYWRIGHT_CHROMIUM` (see [Tests](#tests)).

## Security properties to keep

- **Agent connections.** A certificate is accepted only if all of these hold:
  - this server issued it;
  - it is recorded for an active cabinet;
  - it is not revoked and not expired;
  - its subject names that cabinet.

  A machine without such a certificate gets `401 certificate_refused` on every route except enrollment and health.
- **Bootstrap tokens.**
  - Only a hash of each token is stored.
  - A token works once and expires after 7 days.
  - Unknown, used and expired tokens all get the same answer.
  - Enrollment is rate-limited per address.
- **Request bodies** are validated against the shared contracts before anything reads them. Results are checked against the server's own record of which operation it sent.
- **The audit log** is a hash chain, written only through `audit_append()`:
  - That function runs as a role that can only insert entries.
  - The entry is written in the same transaction as the action.
  - The table refuses UPDATE, DELETE and TRUNCATE, even from its owner.
  - `platform-admin audit-verify` finds the first changed entry.
- **The development issuing key** refuses to run when `NODE_ENV=production`. The production issuing key (plan item 3.1, D143) replaces the one function in `src/runtime.ts`.

## Alerts engine

Each new event is checked against the live symptom rules in the transaction that stores it (`src/services/alerts.ts`, `src/services/rules.ts`):
- **Matching** uses structured fields only (event type, log, source, event ID, level, hardware ID) and a plain, case-insensitive phrase. There are no regular expressions, so no rule can stall the server. The same match is also built as parameterized SQL for the 30-day fleet preview, and a test checks both forms agree.
- **Built-in rules:** scanner events → Fingerprint scanner problem, SMART warnings → Drive failing, firewall changes without a platform command → Unexpected firewall change.
- **Anything unmatched** is a minor unrecognized alert, grouped by log, source and event ID.
- **Correlation:** one active alert per issue per cabinet, with occurrences and first and last seen. The same issue on two or more cabinets at a site within an hour is flagged as a site-wide pattern.
- **Claims are atomic** (`UPDATE … WHERE state = 'open'`). The loser is told who won, and both outcomes are audited.
- **Rules:** a Tier 2 user's rule is a proposal until an Admin approves it; an Admin's goes live at once. Both need step-up, and every change is kept in `symptom_rule_history` and the audit log.
- **Offline:** a job every minute raises Cabinet offline past the threshold (`alerts.offlineDays`, default 5) and resolves it when the cabinet is back.
- **Live stream:** new major alerts go to every signed-in console, and claims and resolutions go to everyone (the notifications table, read by every server process).

## Writes and the software library

- **Every write command** goes through the same checks, inside the transaction that records it (`src/services/writes.ts`):
  - a step-up token for exactly that operation and cabinet;
  - the fleet-wide pause, then the client's pause;
  - the cabinet not installed read-only;
  - the user's own pause, then their hourly limit. Going over the limit pauses that user's writes until an Admin resumes them.

  Each write is audited as `command.write`.
- **Package checks on upload** (`src/packages/`) use Node's standard library only:
  - A bounded ASN.1 reader, the CMS signature check, the driver catalog's member list, a ZIP reader with size, CRC and path checks, the PE Authenticode hash, and a compound-file reader for the MSI hash.
  - A driver package is a ZIP with its `.inf`, the catalog it names, and files whose hashes the catalog lists. An MSI is checked against its embedded signature.
  - The signer must be on `contracts/trust/trusted-publishers.json` for that package type, with a chain to its pinned root.
  - `platform-admin package verify <file> --type driver|msi` runs the same checks on a file without a database.
- **The library.**
  - A package is stored as `<sha256>.pkg`, read-only, under `PACKAGE_DIR` (default `data/packages`, at most `PACKAGE_MAX_MB`, default 500).
  - The Admin who uploaded it can never approve it (a database CHECK enforces this as well). Retiring is final; changing a package means uploading a new version.
- **Downloads.** `GET /agent/v1/packages/:id` serves an approved package only while that cabinet has a delivered `package.install` command for it that is under 30 minutes old. Each download is audited.
- **Firewall history** (`firewall_changes`) records every successful firewall write. It also records every firewall change a cabinet reports: marked as the platform's when it names one of that cabinet's own firewall commands, otherwise unexplained.

## Administration and security alerts

- **Accounts** (`src/services/users.ts`):
  - Every change needs a step-up token for that account.
  - Resets, disabling, deleting and role changes end the person's sessions.
  - The last active Admin cannot be removed; account changes are serialized so a race cannot remove it either.
  - Promotion needs an authenticator.
- **Security alerts** (`src/services/security.ts`) go to Admins only, folded by signature, and are pushed on the live stream.
  - Triggers: the write limit (`commands.ts`), locking after failed sign-ins or step-ups (`auth-routes.ts`), a new sign-in network, the audit chain check (`maintenance.ts`), the agent's security events and refused packages (`events.ts`, `commands.ts`), and refused certificates (`agent-api/server.ts`).
- **Daily jobs** (`src/services/maintenance.ts`): the audit chain check and retention. **Every minute:** offline alerts and expiring suppressions.
- **Settings** (`src/services/settings.ts`) are read through a 5-second cache on every request, because session timeouts come from them.

## Device settings that follow the client

`src/services/device-settings.ts`.
- **Scanner hardware IDs:** the most specific of cabinet, site, client and fleet applies. They reach the agent in each heartbeat answer and in `peripheral.status`.
- **Sync ports:** site, then client, then fleet. They are filled into `network.test` for the sync cabinet, replacing anything the browser sent.
- **Routes:** `PUT /api/{clients,sites,cabinets}/:id/scanner`, `PUT /api/settings/scanner`, `PUT /api/clients/:id/sync-ports`, `PUT /api/settings/sync-ports`, `PUT /api/sites/:id/sync`.

## Signed upgrades (Milestone 7)

docs/spec/07-upgrade-channel.md; `src/services/releases.ts`, `src/services/rollouts.ts`, `src/console-api/upgrade-routes.ts`.

- **The update store.** An Admin adds a release: the manifest exactly as the pipeline signed it, its signature, then the zip. The server checks the signature against `contracts/trust/upgrade` (the keys agents compile in), the zip's hash and size against the manifest, and that the version is higher than every earlier release.
  - The server never holds the signing key and cannot make a release an agent accepts.
  - A bad signature raises a security alert.
- **Staged rollouts** (one at a time, step-up, each step audited):
  - Batch 1: one cabinet. Batch 2: in-office cabinets. Batch 3: 5% of the rest. Batch 4: everyone else.
  - The heartbeat answer offers the version to cabinets in the batches reached so far. The release is downloadable only by cabinets it was offered to.
  - Agents report the outcome to `POST /agent/v1/upgrade-status`. A heartbeat on the new version also counts as success.
  - A batch must reach its success rate before the next starts. Failures above the limit pause the rollout automatically. A cabinet silent for 30 minutes after its offer counts as failed. Offline cabinets are skipped after 24 hours.
- **CLI:**
  - `platform-admin release check|add|list`
  - `platform-admin rollout start|list|show|pause|resume|stop`
  - `platform-admin cabinet in-office <id> on|off`
- `UPGRADE_KEYS_DIR` (tests only) points at another key folder; `RELEASE_DIR` sets the store.

## Console API

The console listener runs when `CONSOLE_ORIGIN` is set. It is meant to sit behind the internal reverse proxy, reachable only on the internal network or VPN. It takes these environment variables:

| Variable | Purpose |
| --- | --- |
| `CONSOLE_ORIGIN` | The console's exact origin. State-changing requests must carry it. |
| `CONSOLE_SECRET_KEY` | 32 random bytes, base64. Encrypts authenticator secrets; keep it in the secret store. |
| `CONSOLE_PORT`, `CONSOLE_HOST` | The listener (default 127.0.0.1:8080). |
| `CONSOLE_STATIC_DIR` | The built console (default `../console/dist`). |
| `CONSOLE_TRUST_PROXY` | Read the client address from the proxy: the number of proxies in front (usually `1`), or the proxies' own addresses. Only the address the nearest trusted proxy saw is used, never what the client wrote in `X-Forwarded-For`. |

Security behaviour:
- **Passwords** are hashed with Argon2id.
- **Authenticator codes** follow RFC 6238. Their secrets are encrypted with AES-256-GCM, and a code cannot be used twice.
- **Sessions** are stored on the server. The cookie is HttpOnly, Secure and SameSite=Strict, and sessions expire after 30 minutes idle or 12 hours at most.
- **Lockout:** 5 failed attempts lock the account for 15 minutes. There are also per-address limits.
- **Step-up tokens** are bound to one action and one target, valid for 2 minutes, and work once.
- **Roles** are checked on every route.

## Run it locally

```bash
# SQL Server 2022 (for example: docker run -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='<strong password>' -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest)
export DATABASE_OWNER_URL='sqlserver://sa:<password>@localhost:1433/cabinet?trustServerCertificate=true'   # creation and migrations only
node ../deploy/database-setup.mjs create
npm ci && npm run build && npm run admin -- migrate
APP_DB_PASSWORD=<24 to 128 letters and digits> node ../deploy/database-setup.mjs login
export DATABASE_URL='sqlserver://cabinet_app_login:<that password>@localhost:1433/cabinet?trustServerCertificate=true'   # use encrypt with a real certificate in production
export DEV_PKI_DIR=$HOME/.cabinet-dev-pki AGENT_API_HOSTNAMES=localhost,<this machine's name or IP>
export CONSOLE_ORIGIN=http://localhost:8080 CONSOLE_PORT=8080 CONSOLE_SECRET_KEY=$(openssl rand -base64 32)
(cd ../console && npm ci && npm run build)
npm start                                                           # agent API on :8443, console on http://localhost:8080

npm run admin -- user add --username you --name "Your Name" --role admin   # prints a temporary password; sign in at the console
# Every command that changes something needs --as and --code: the 6-digit code from your authenticator (set up at your first console sign-in).
npm run admin -- token create --as you --code <code>   # give this and $DEV_PKI_DIR/dev-issuing-ca.cert.pem to the cabinet installer
npm run admin -- pending
npm run admin -- approve <requestId> --as you --code <code> --client "Client" --site "Site" --cabinet "Cabinet 1" --role standalone
npm run admin -- cabinets
npm run admin -- issue <cabinetId> peripheral.status --as you --code <code>
npm run admin -- command <commandId>
```

On the cabinet, in an elevated PowerShell:

```powershell
./agent/install/Install-CabinetAgent.ps1 -PlatformServerHost <server> -PlatformServerPort 8443 -PlatformCaFile dev-issuing-ca.cert.pem -BootstrapTokenFile token.txt   # the token saved in a file (also accepted: -BootstrapToken <token>)
```

## Load test (8,000 agents)

`test/load/agents.ts` simulates thousands of cabinets with their own certificates (long polls, heartbeats, events and command round trips) against a running server, and fails when a threshold is missed. How to run it, the thresholds, and the measured results (8,000 agents with no failures, command delivery p95 13 ms) are in [docs/platform/performance.md](../docs/platform/performance.md). CI runs 1,000 agents for 3 minutes on every push.

## Tests

`npm test` needs a SQL Server 2022 where `TEST_DATABASE_ADMIN_URL` (default `sqlserver://sa:Dev-Only-Pass-1%21@localhost:1433/master?trustServerCertificate=true`) can create databases. Each test file gets its own database.

The end-to-end test runs the real agent connection code against the server when `TEST_AGENT_DLL` points at the built `agent/tests/Cabinet.Agent.TestAgent`, as CI does.

It also drives the agent's background monitors through the test agent, which reads simulated devices and event-log entries from `<stateDir>/simulate`. A forced scanner disconnect must raise Fingerprint scanner problem, and an unrecognized error, once mapped and approved, must raise its issue the next time. `test/console-alerts-e2e.test.ts` does the same in real browsers: one Tier 2 user maps the error, an Admin approves it, and three consoles race to claim the major alert it raises.

# Platform server

The Node 22 + TypeScript + Fastify server from docs/spec/05-server-spec.md. This is Milestone 2: the database, and the agent API with mutual TLS, enrollment, certificates, heartbeats and the long-poll command channel. The console API arrives in Milestone 3.

## What is here

| Path | Contents |
| --- | --- |
| `migrations/` | Versioned SQL, applied in order. An applied migration can never change; add a new one. |
| `src/db/` | Pool, transactions, the audit helper and chain verification, and the migration runner |
| `src/pki/` | A small DER codec, CSR checks and certificate issuing. All signing goes through `IssuingKey.signTbs`. |
| `src/services/` | Enrollment and approval, cabinet authentication, heartbeats and renewal, commands, events |
| `src/agent-api/` | The agent listener: TLS terminated by Node, client certificates checked against the database on every request |
| `src/cli.ts` | `platform-admin`, the operator tool until the console exists |

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
- **The development issuing key** refuses to run when `NODE_ENV=production`. The KMS key replaces the one function in `src/runtime.ts`.

## Run it locally

```bash
createdb cabinet
export DATABASE_OWNER_URL=postgres://owner@localhost/cabinet        # migrations only
npm ci && npm run build && npm run admin -- migrate
psql cabinet -c "CREATE ROLE cabinet_app_dev LOGIN PASSWORD '<choose one>'; GRANT cabinet_app TO cabinet_app_dev;"
export DATABASE_URL=postgres://cabinet_app_dev:<password>@localhost/cabinet
export DEV_PKI_DIR=$HOME/.cabinet-dev-pki AGENT_API_HOSTNAMES=localhost,<this machine's name or IP>
npm start                                                           # agent API on :8443

npm run admin -- user add --username you --name "Your Name" --role admin
npm run admin -- token create --as you        # give this and $DEV_PKI_DIR/dev-issuing-ca.cert.pem to the cabinet installer
npm run admin -- pending
npm run admin -- approve <requestId> --as you --client "Client" --site "Site" --cabinet "Cabinet 1" --role standalone
npm run admin -- cabinets
npm run admin -- issue <cabinetId> peripheral.status --as you
npm run admin -- command <commandId>
```

On the cabinet, in an elevated PowerShell:

```powershell
./agent/install/Install-CabinetAgent.ps1 -PlatformServerHost <server> -PlatformServerPort 8443 -PlatformCaFile dev-issuing-ca.cert.pem -BootstrapToken <token>
```

## Tests

`npm test` needs a PostgreSQL where `TEST_DATABASE_ADMIN_URL` (default `postgres://platform_owner:dev-only-local@localhost:5432/postgres`) can create databases. Each test file gets its own database.

The end-to-end test runs the real agent connection code against the server when `TEST_AGENT_DLL` points at the built `agent/tests/Cabinet.Agent.TestAgent`, as CI does.

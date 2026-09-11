# Cabinet_support_tool

An internal support tool for Mashura CUBEX/ZIMBIS smart inventory cabinets in
veterinary and dental clinics. It lets support staff diagnose, monitor and
perform routine IT actions on client cabinet PCs without taking a remote
desktop session.

The cabinets are DEA-compliant controlled-substance dispensing systems with
biometric access and chain-of-custody records. The audit trail this server
writes may be read in a compliance context, and the code is built accordingly.

## Components

| Component | Project | Status |
|---|---|---|
| **Contracts** | `src/Mashura.CabinetSupport.Contracts` | Shared enums and DTOs |
| **Server** | `src/Mashura.CabinetSupport.Server` | ASP.NET Core Web API |
| **Agent** | *(not in this repository yet)* | .NET Worker Service on each cabinet PC |
| **Console** | *(not built yet)* | WPF desktop app |

## Security properties

These are the invariants the code and the test suite exist to hold:

- **No arbitrary execution.** No endpoint accepts a command string, script body
  or SQL text, at any role, Supervisor included. The action catalogue is a
  fixed enum defined in code (`Actions/ActionCatalog.cs`) and cannot be altered
  at runtime. Parameters are validated key-by-key against a per-action
  allow-list, and service names against a separate server-side allow-list.
- **Default deny.** The fallback authorization policy denies, so an endpoint
  that forgets its policy fails closed. A test enumerates every controller
  action and asserts each one names an explicit, known policy.
- **The server is the sole authority.** Roles, permissions and cabinet
  identity are always resolved from the authenticated principal, never from a
  request body, header or query string.
- **An agent reports nothing usable until approved.** A check-in from a machine
  that is not an approved, active cabinet is refused with 403 and stores no
  telemetry — and the attempt is audited.
- **Every request is audited, denials included.** Refusals inside the
  authorization middleware, before any controller runs, are recorded by
  `AuditingAuthorizationResultHandler`.
- **Observed and Caused are structurally distinct.** A read is Observed; a
  change to a cabinet's state is Caused. They are separate enum values on the
  record, never derived from one another at read time.
- **The approver is never the requester.** Enforced by an explicit check in
  `ActionRequestService.ApproveAsync`, not by hiding a button.
- **No hardware actuation.** Nothing opens a drawer, unlocks a lock or opens a
  cubie.
- **No secrets in source.** Passwords are PBKDF2-HMAC-SHA256 with a per-user
  salt and a minimum of 100,000 iterations (210,000 by default), verified in
  constant time. No password or hash is ever logged or returned.

## Configuration

Three values have no default and must be supplied per deployment. The server
refuses to start without them rather than falling back to anything guessable:

| Setting | Environment variable |
|---|---|
| JWT signing key (≥ 32 bytes) | `Jwt__SigningKey` |
| Agent shared secret | `AgentAuth__SharedSecret` |
| Initial Supervisor password | `Seed__SupervisorInitialPassword` |

Everything else has a documented default in `appsettings.json`: password
policy, lockout and rate limits, agent ingest intervals, action expiry and the
maintenance window, retention windows, query limits, and the service
allow-list.

`Seed__SupervisorInitialPassword` is only used when the user table is empty. The
seeded account is flagged `MustChangePassword`, so the value buys exactly one
login and nothing else.

## Running

```bash
export Jwt__SigningKey="<32+ byte key from your secret store>"
export AgentAuth__SharedSecret="<agent key>"
export Seed__SupervisorInitialPassword="<strong initial password>"

dotnet run --project src/Mashura.CabinetSupport.Server
```

Migrations are applied on startup. `GET /health` is anonymous, for a load
balancer probe; it reports check names and statuses only.

```bash
dotnet test
```

## Agent authentication

This build proves an agent by a shared secret in a header, compared in constant
time. Mutual TLS with per-cabinet client certificates is the planned upgrade,
and the check is isolated behind `IAgentAuthenticator` so that swap touches one
implementation — no controller, policy or audit path reads the header itself.

Presenting a valid agent key proves only that the caller is *some* agent. Every
agent endpoint separately resolves the cabinet from the database and checks it
was approved.

## Scale and persistence

SQLite today, PostgreSQL later: every query is LINQ with no provider-specific
SQL, so the swap is a package reference and a connection string.

The design assumes tens of thousands of cabinets checking in every few minutes:

- `CheckIn` is indexed on `(CabinetId, ReceivedUtc desc)` — the "latest for this
  cabinet" query is the hottest path in the system.
- List views project to extracted columns and never deserialise the stored
  payload. The raw payload is kept beside them for forensics.
- Every list endpoint is paged, and every read query uses `AsNoTracking()`.
- The server is stateless: no in-memory session state and no local file writes
  on the request path, so instances can sit behind a load balancer unchanged.
- Check-ins are idempotent per `(CabinetId, CollectedAtUtc)`, backed by a unique
  index, because agents retry over flaky clinic networks.

## Retention

`RetentionService` keeps full-resolution `CheckIn` rows for 30 days, keeps
full-resolution `SmartReading` rows for 90 days, then rolls older readings into
one row per drive per day holding that day's worst observed value for each
counter — the shape failure prediction needs. Aggregates are kept for two
years.

`AuditEntry` is never deleted or aggregated, at any age. Audit rows are
append-only in practice: there is no update or delete method on the audit
service, and `SupportDbContext` throws `AuditImmutabilityException` if a
modified or deleted audit entry reaches `SaveChanges`.

## Notes on this revision

- The `RequireElevatedSql` policy is wired up and testable but currently guards
  no endpoint. It exists for a future read-only elevated diagnostic surface.
  It does not, and will not, enable running a query someone typed.
- The `Contracts` project is defined here alongside the server; the agent and
  console consume the same assembly so the three cannot drift into private
  dialects. The wire convention (camelCase, enums as names) is defined once in
  `Contracts/Common/ContractJson.cs`.

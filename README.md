# Mashura Cabinet Diagnostics Platform

A remote diagnostics and monitoring platform for Mashura's medication cabinets (about 8,000 Windows cabinets in the field). It has two jobs:

- **Diagnose without manual searching.** A support person opens a cabinet in the browser console and runs fixed, typed diagnostics: event logs, the fingerprint scanner checklist, devices and drivers, drive health, Windows updates, network tests and the firewall. Results come back in seconds, with no remote desktop.
- **Be proactive.** Each cabinet's agent watches for errors, scanner problems, failing-drive warnings and firewall changes. It sends them to the server, which files them under issue types, raises major and minor alerts, and keeps every unrecognized error so the team can categorize it.

Changes to a cabinet are limited to a small, audited catalog of operations: network settings, firewall, approved driver and software packages, and signed agent upgrades. Each needs the right role and an authenticator code. Network and firewall changes are undone automatically if the cabinet loses the server.

The specification in [docs/spec](docs/spec/00-README.md) is the source of truth. Standing rules for working on the code are in [CLAUDE.md](CLAUDE.md).

## Layout

| Folder | What | Stack |
|---|---|---|
| [`contracts/`](contracts/README.md) | JSON Schemas for every message and operation, valid and hostile examples, generated TypeScript types. The agent, server and console are all built against them. | JSON Schema 2020-12, Ajv |
| [`server/`](server/README.md) | Two APIs:<br>• the agent API (mutual TLS, long poll, heartbeats, events, results, packages, upgrades);<br>• the console API (sign-in, roles, step-up, alerts, writes, administration).<br>Plus the alerts engine, audit log and CLI. | Node.js 22, TypeScript, Fastify 5, PostgreSQL 16 |
| [`console/`](console/README.md) | The support console, served by the server from the same origin. | React 19, TypeScript, Vite |
| [`agent/`](agent/README.md) | The Windows agent:<br>• a low-privilege network service;<br>• a LocalSystem broker with no network code;<br>• a signed updater;<br>• install and release scripts. | C# .NET 8, self-contained |
| [`docs/platform/`](docs/platform/) | Platform documentation beyond the spec: [performance and capacity](docs/platform/performance.md). | |
| `src/`, `tests/`, `tools/`, `CabinetPlatform.sln` | **The earlier C# demo, superseded by this platform.** Kept for reference until it is removed; its CI workflow runs only by hand. See [legacy](#legacy). | |

## How it fits together

```
 Support staff (browser)                       Cabinets (Windows 10/11)
        │ HTTPS, same origin                           │ HTTPS, mutual TLS, outbound only
        ▼                                              ▼
 ┌───────────────┐    ┌──────────────────────────────────────────┐
 │ console (SPA) │───▶│ server: console API ─┬─ agent API        │◀── network service (no admin rights)
 └───────────────┘    │   alerts engine, audit log, rollouts     │        │ named pipe, typed requests only
                      └──────────────┬───────────────────────────┘        ▼
                                     │                                broker (LocalSystem, no network)
                               PostgreSQL 16
```

- A cabinet only ever connects out. Commands reach it over a long poll. The server announces new commands, so delivery takes milliseconds ([performance](docs/platform/performance.md)).
- Each command is checked by the agent itself: the operation is in its compiled-in catalog, the cabinet is its own, the command is unexpired and not replayed, the parameters pass their schema, and writes stay within limits and read-only mode. The server cannot add an operation.
- The full design is in [architecture](docs/spec/01-architecture.md) and the [security model](docs/spec/02-security-model.md).

## Build and test

Each part builds and tests on its own. CI (`.github/workflows/platform-contracts.yml`) runs all of them on every push. Linux runs the contracts, the server with a real agent end to end, the console in a real browser, and a 1,000-agent load check. A Windows runner installs the real services and runs the write operations, real signed packages, a signed upgrade and an automatic rollback.

```sh
cd contracts && npm ci && npm test                     # schemas, examples, generated types
cd agent && dotnet build Cabinet.Agent.sln -c Release && dotnet test tests/Cabinet.Agent.Core.Tests -c Release
cd console && npm ci && npm run build
cd server && npm ci && npm test                         # needs PostgreSQL; see server/README.md
```

To run the whole platform locally and connect a Windows test cabinet, see [server/README.md "Run it locally"](server/README.md#run-it-locally) and [agent/README.md](agent/README.md).

Do not install the agent on a production cabinet from a developer build. Release builds come only from the build pipeline, signed ([upgrade channel](docs/spec/07-upgrade-channel.md)).

## Status

- **Built:** all seven milestones of the [build plan](docs/spec/08-build-plan.md), plus:
  - the alert catalog and per-symptom severity;
  - scanner IDs and sync ports set per client;
  - the 8,000-agent load test.
- **Before the first real release:** the release signing key in a KMS, and the production code-signing certificate.
- **Before field rollout:**
  - a test on a real cabinet;
  - the load test repeated on production hosting;
  - an independent security test;
  - incident-response steps and a database restore test.

Decisions taken and still open are recorded in [open decisions](docs/spec/09-open-decisions.md).

## Legacy

`src/`, `tests/`, `tools/`, `CabinetPlatform.sln`, `Directory.Build.props` and most files directly in `docs/` belong to the earlier C# demo (Server, Agent, web Console and demo tools). The platform above replaces all of it. It is kept only as reference; its workflow (`demo-correction-checks.yml`) runs only when started by hand; and it is scheduled for removal. Do not extend it.

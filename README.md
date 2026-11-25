# Cabinet Diagnostics Platform

A remote diagnostics and monitoring platform for medication cabinets, across a fleet of about 8,000 Windows machines. It has two jobs:

- **Diagnose without manual searching.** A support person opens a cabinet in the browser console and runs fixed, typed diagnostics: event logs, the fingerprint scanner checklist, devices and drivers, Windows updates, network tests and the firewall. Results come back in seconds, with no remote desktop.
- **Be proactive.** Each cabinet's agent watches for errors, scanner problems and firewall changes, and reports its free disk space. It sends them to the server, which files them under issue types, raises major and minor alerts, and keeps every unrecognized error so the team can categorize it.

Changes to a cabinet are limited to a small, audited catalog of operations: network settings, firewall, approved driver and software packages, and signed agent upgrades. Each needs the right role and an authenticator code. Network and firewall changes are undone automatically if the cabinet loses the server.

The specification in [docs/spec](docs/spec/00-README.md) is the source of truth. Standing rules for working on the code are in [CLAUDE.md](CLAUDE.md).

## Layout

| Folder | What | Stack |
|---|---|---|
| [`contracts/`](contracts/README.md) | JSON Schemas for every message and operation, valid and hostile examples, generated TypeScript types. The agent, server and console are all built against them. | JSON Schema 2020-12, Ajv |
| [`server/`](server/README.md) | Two APIs:<br>• the agent API (mutual TLS, long poll, heartbeats, events, results, packages, upgrades);<br>• the console API (sign-in, roles, step-up, alerts, writes, administration).<br>Plus the alerts engine, audit log and CLI. | Node.js 22, TypeScript, Fastify 5, SQL Server 2022 |
| [`console/`](console/README.md) | The support console, served by the server from the same origin. | React 19, TypeScript, Vite |
| [`agent/`](agent/README.md) | The Windows agent:<br>• a low-privilege network service;<br>• a LocalSystem broker with no network code;<br>• a signed updater;<br>• install and release scripts. | C# .NET 10 (LTS), self-contained |
| [`deploy/`](deploy/README.md) | Runs the whole platform on one Linux VPS with Docker Compose (SQL Server, server, console behind Caddy HTTPS), and builds the Windows agent package the console offers for download. For demos and pilots. | Docker, Caddy |
| [`docs/platform/`](docs/platform/) | Documentation beyond the spec: the [demo guide](docs/platform/demo.md), [testing a live agent](docs/platform/live-test.md), [performance](docs/platform/performance.md), the [threat model](docs/platform/threat-model.md), the [security review](docs/platform/security-review.md) and [data classification](docs/platform/data-classification.md). | |

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
                               SQL Server 2022
```

- A cabinet only ever connects out. Commands reach it over a long poll. The server announces new commands, so delivery takes milliseconds ([performance](docs/platform/performance.md)).
- Each command is checked by the agent itself: the operation is in its compiled-in catalog, the cabinet is its own, the command is unexpired and not replayed, the parameters pass their schema, and writes stay within limits and read-only mode. The server cannot add an operation.
- The full design is in [architecture](docs/spec/01-architecture.md) and the [security model](docs/spec/02-security-model.md).

## Build and test

Each part builds and tests on its own. CI (`.github/workflows/platform-contracts.yml`) is set up to run on every push. Linux runs the contracts, the server with a real agent end to end, the console in a real browser, and a 1,000-agent load check. A Windows runner installs the real services and runs the write operations, real signed packages, a signed upgrade and an automatic rollback. It is green on `main` from `7d38a6a` (run 44675273893). The local suites below are still run on each change and quoted in the PR.

Run each line from the repository root:

```sh
(cd contracts && npm ci && npm test)                    # schemas, examples, generated types
(cd agent && dotnet build Cabinet.Agent.sln -c Release && dotnet test tests/Cabinet.Agent.Core.Tests -c Release && dotnet test tests/Cabinet.Agent.Contracts.Tests -c Release)
pwsh -File agent/install/tests/run-tests.ps1             # the publisher root, the upgrade trust list, the release gate
(cd console && npm ci && npm run build)
(cd server && npm ci && npm test)                        # needs SQL Server; see server/README.md
```

To run the platform on a VPS and demo it with your own laptop and a simulated fleet, see [deploy/README.md](deploy/README.md) and the [demo guide](docs/platform/demo.md). To run the whole platform locally and connect a Windows test cabinet, see [server/README.md "Run it locally"](server/README.md#run-it-locally) and [agent/README.md](agent/README.md).

Do not install the agent on a production cabinet from a developer build. Release builds come only from the build pipeline, signed ([upgrade channel](docs/spec/07-upgrade-channel.md)).

## Where it stands

The build plan's milestones 0 to 12 are built: the agent, both APIs, the console, signed upgrades, the firewall policy, services, network diagnosis with the full read and path trace, crash investigation, time zones, fleet operations, evidence packages, known fixes with approval, and demo mode. The agent's catalogue has 56 operations (`contracts/schemas/operations/catalog.json`). The Midnight Navy and Electric Cyan design system is used throughout. What is left, item by item with what proves each, is the [plan to completion](docs/platform/plan-to-completion.md). The [roadmap](docs/spec/13-roadmap.md) is the owner's module list and the plan for it; it is not a status page, so read the code or the plan before taking a "to build" there as unbuilt.

The platform is live on the VPS, and real Windows machines have run the agent ([testing a live agent](docs/platform/live-test.md) has the detail):

- **2026-10-25, read-only:** the agent self-updated to 0.2.5 and answered 19 of the 34 read operations it had then; read-only mode refused the one write tried.
- **2026-10-30, agent 0.3.1 on a 64-bit Windows 11 machine:** 34 of 34 reads and the reversible writes worked; the fixes that came out of it are in the decision log.
- **2026-11-13, read-write, a 64-bit desktop:** of the 44 checks in the write sweep, 21 passed, each checked in the machine's own state and put back (time, DNS, the DHCP lease, firewall rules and profiles, power, the cancel path of a restart, and the rights refusals). The service and process writes have not run on real hardware: they wait for an Admin to set an approved-programs list, which is the intended default. The same run found and fixed a broker that refused three of its own reads, which had stopped every install since 2026-11-03 (#239).
- **2026-11-13, the 32-bit package** ran on that 64-bit machine, installed on purpose with `-AllowArchitectureMismatch` (#241), and the platform recorded it as `windows-x86`.

Still to do before a field rollout, in the [plan to completion](docs/platform/plan-to-completion.md):

- The production issuing CA, from our own offline root (D143). Nothing is bought: the publisher root is ours and the installer pins it.
- The rest of the write sweep on real hardware (the service and process writes, once an approved-programs list is set), and both sweeps on a real 32-bit machine. A 32-bit process on 64-bit Windows (the `-AllowArchitectureMismatch` test install) is shown the 32-bit registry, so there `software.list` lists only 32-bit programs; an install check alone covers neither.
- The load test repeated on production hosting, the security review brief worked through by us in place of a bought test (D143), the incident-response steps and a database restore test.

Decisions made and still open are in [open decisions](docs/spec/09-open-decisions.md). What comes next, module by module, is in the [roadmap](docs/spec/13-roadmap.md).

The earlier C# demo that this platform replaced was removed in October 2026. It is still in git history.

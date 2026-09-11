# Cabinet Support Tool

An internal support tool for Mashura CUBEX/ZIMBIS smart inventory cabinets in
veterinary and dental clinics. It lets support staff diagnose, monitor and
perform routine IT actions on client cabinet PCs without taking a remote
desktop session.

The cabinets are DEA-compliant controlled-substance dispensing systems with
biometric access and chain-of-custody records. The audit trail this server
writes may be read in a compliance context, and the code is built accordingly.

## Components

| Project | What it is |
| --- | --- |
| `src/CabinetPlatform.Contracts` | Shared types crossing every process boundary. References nothing. |
| `src/CabinetPlatform.Agent` | .NET Worker Service on each cabinet PC. Reads data, reports it, performs only named actions. |
| `src/CabinetPlatform.Server` | ASP.NET Core Web API. The only component that makes authorization decisions. |
| `src/CabinetPlatform.Console.Core` | The console's logic layer: API client and ViewModels. No WPF reference, so it is testable on any platform. |
| `src/CabinetPlatform.Console` | WPF desktop shell. Views and code-behind only. |

Agent, server and console each reference contracts. Nothing references the
agent or the console.

The console is split so that its ViewModels cannot reach a `Window`, a
`Dispatcher` or a `MessageBox`: those types are not on the compile path of
`Console.Core`. That makes "no business logic in code-behind" a property of the
build.

The WPF project needs the Windows Desktop SDK. Some distribution-packaged .NET
SDKs are source-built with it stripped out, and on those the Console project
cannot be evaluated — everything else still builds and tests. See
[docs/console.md](docs/console.md).

## Ground rules

- Actions come from a fixed catalog (`ActionName`). No command lines, script
  bodies or SQL text travel anywhere in this system.
- The server decides every permission. The agent and console never enforce
  their own rules.
- Agent connections are outbound-only. Nothing is exposed for inbound access
  into a cabinet.
- A new agent lands in a pending queue and reports nothing usable until a
  Supervisor approves and assigns it.
- Cabinets are identified by a stable hardware-derived id, never by hostname.
- Every action writes an audit record, denials included, and says whether the
  platform observed something or caused it.
- Disruptive actions require a second person's approval, and the approver is
  never the requester.
- No hardware actuation: no drawer open, no lock release, no cubie open.
- Biometric data is never stored or transmitted — only that an auth event
  occurred, who it matched and how it resolved.
- No secrets in source, no plaintext passwords anywhere.
- A value that could not be read is `null`, never `0`. Zero for missing poisons
  every trend built on top of it.

## Documentation

- [Shared contracts](docs/contracts.md)
- [Check-in tiers and retention](docs/check-in-tiers.md)
- [Site topology and the sync cabinet](docs/topology.md)
- [Time zones](docs/time-zones.md)
- [Data residency — open question](docs/data-residency.md)
- [Agent](docs/agent.md) and [agent installation](docs/agent-install.md)
- [Console](docs/console.md)
- [Building](docs/building.md)

# Cabinet Support Tool

An internal support tool for Mashura CUBEX/ZIMBIS smart inventory cabinets. It
lets support staff diagnose, monitor and perform routine IT actions on client
cabinet PCs without taking a remote desktop session.

The cabinets are DEA-compliant controlled-substance dispensing systems, so this
software sits next to a compliance system. Audit quality is a functional
requirement, not a nicety.

## Components

| Project | What it is |
| --- | --- |
| `src/CabinetPlatform.Contracts` | Shared types crossing every process boundary. References nothing. |
| `src/CabinetPlatform.Agent` | .NET Worker Service on each cabinet PC. Reads data, reports it, performs only named actions. |
| `src/CabinetPlatform.Server` | ASP.NET Core Web API. The only component that makes authorization decisions. |
| `src/CabinetPlatform.Console` | WPF desktop app for support staff. |

Agent, server and console each reference contracts. Nothing references the
agent or the console.

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
- Disruptive actions require a second person's approval.
- No hardware actuation: no drawer open, no lock release, no cubie open.
- Biometric data is never stored or transmitted — only that an auth event
  occurred, who it matched and how it resolved.
- No secrets in source, no plaintext passwords anywhere.

## Documentation

- [Shared contracts](docs/contracts.md)
- [Building](docs/building.md)

# Cabinet Support Tool

An internal Cabinet Support product. Staff use a browser-based support Console to inspect cabinets and request only approved operations. Each cabinet runs a Windows Agent service; there is no desktop Console delivery target.

Production release is blocked while the audited defects are repaired and Windows lab testing is completed. See the [current build tracker](docs/build-tracker.md) and [release gates](docs/readiness.md). Passing automated tests does not establish that a cabinet is safe to deploy.

## Where it runs

Mashura hosts the support API, its database and the target same-origin web Console. Staff use a browser. Each customer cabinet runs a Windows Agent service that initiates outbound connections to the API.

Clients can have multiple locations and several cabinets at each location. Typically one cabinet holds the location's application database and acts as the sync cabinet. Other cabinets communicate with it locally. The Mashura support server does not replace or read that application database.

The target placement and trust boundaries are in [architecture](docs/architecture.md).

## Scope

The current release composition is monitoring only: process and event observations, inventory and storage health. Legacy `Demo` and `Maintenance` settings cannot enable cabinet mutations or update scheduling. Historical control implementations remain for safety regression tests in a separate, non-distributable build configuration. See the [compiled monitoring boundary](docs/restricted-demo-mode.md) for the exact allowlist and both test lanes. Future governed updates require a separately reviewed release.

Physical cabinet sensors, drawer opening, lock release and cubie opening remain excluded. The Windows support scope does not permit arbitrary shell commands, scripts or access to patient records.

## Projects

1. `CabinetPlatform.Contracts` defines the messages shared across processes.
2. `CabinetPlatform.Agent` collects machine information and performs named Windows actions through typed gateways.
3. `CabinetPlatform.Server` owns support authorization, device registration, topology, approvals and result storage.
4. `CabinetPlatform.Web` is the **web Console**: a sign-in page, then a secure backend-for-frontend and browser app for support staff and administrators, wired to the real Server API, with a Live/Demo switch. See [web Console](docs/web-console.md). The earlier preview pages are kept under `legacy-preview/`.
5. `CabinetPlatform.DemoBff` is an earlier minimal password demo, superseded by the web Console and kept for its tests.
6. `CabinetPlatform.WebHost` currently provides a fail-closed Entra sign-in boundary, not yet an authorized cabinet-data BFF. Integrating it with the web Console is a release gate.

`CabinetPlatform.Console.Core` remains temporarily as a test dependency for Agent and Server safety regressions. The WPF executable and native shell harness are retired; neither is a product milestone or fallback. Move the remaining Core tests to Agent/Server test projects before removing Core.

## Quick start: demo with a real PC (e.g. the HP)

Needs the .NET 8 SDK, Node.js 20+ and Tailscale on a Linux host, and the Windows PC on the same tailnet. Full guide: [live Agent setup](docs/live-agent-setup.md).

1. **Server and Console.** Run `tools/live/start-web-console-live.sh --tailscale`. Open the printed Console address. It starts on the **sign-in page**: sign in as `admin` with the printed one-time password, then set your own.
2. **Agent on the PC.** Run `tools/live/build-agent-package.sh`, copy the folder to the PC, and in an elevated PowerShell run the printed `Install-CabinetAgent.ps1` command. Paste the agent key from the secrets file when prompted.
3. **Approve it.** In the Console go to **Administration → Enrollment**, check the machine ID and approve.
4. **Demo.** Go to **Settings → Data source → Demo**. The sample fleet appears alongside your PC, which is marked **● LIVE**. Open the PC, then **Run diagnostic → Run an event log view → Recent errors and warnings**: the Events tab shows the PC's real Windows event log entries. Processes, services, disks, network and updates are real too.

**Without a PC:** `tools/demo/start-web-console-demo.sh` runs everything on one machine with simulated agents, a good rehearsal of the onboarding flow.

Roles, Live/Demo modes and the security model are in [docs/web-console.md](docs/web-console.md).

## Build and test

Use an official .NET 8 SDK and the Node version required by the web project. Cross compilation on Linux does not verify the Windows Agent service or a browser workflow. The final release suite covers Agent, Server, WebHost and web tests; see [release gates](docs/readiness.md). The following are local development commands, not final-release acceptance:

```text
dotnet build src/CabinetPlatform.Agent/CabinetPlatform.Agent.csproj --configuration Release
dotnet build src/CabinetPlatform.Server/CabinetPlatform.Server.csproj --configuration Release
dotnet build src/CabinetPlatform.WebHost/CabinetPlatform.WebHost.csproj --configuration Release
dotnet test tests/CabinetPlatform.Agent.Tests/CabinetPlatform.Agent.Tests.csproj --configuration Release
dotnet test tests/CabinetPlatform.Server.Tests/CabinetPlatform.Server.Tests.csproj --configuration Release
dotnet test tests/CabinetPlatform.WebHost.Tests/CabinetPlatform.WebHost.Tests.csproj --configuration Release
cd src/CabinetPlatform.Web && npm ci && npm test
```

The web-only delivery plan is a rebaseline, not a declaration that these component commands represent the complete final matrix. Do not reintroduce a WPF release gate because older solution/test documentation mentions it.

Do not run the agent, network changes, updates or process controls on a production cabinet while developing. Use an authorized Windows lab machine with an independent recovery console and snapshots. Keep all credentials outside source and test evidence.

## Documentation

Read the [current source-versus-live tracker](docs/build-tracker.md) for implemented behavior, incomplete wiring and verification limits.

1. [Web Console: sign-in, roles, Live/Demo and security model](docs/web-console.md)
1. [Live Agent setup on a real Windows PC](docs/live-agent-setup.md)
1. [Platform specification](docs/spec/00-README.md) and [gap analysis against the current build](docs/spec-gap-analysis.md)
1. [Product requirements](docs/requirements.md)
2. [Architecture and data flow](docs/architecture.md)
3. [Release gates](docs/readiness.md), [Agent-only demo package](docs/independent-demo-kit.md), and [Windows demo checks](docs/testing.md). The static browser preview uses sample data; it is not a connected or accepted Console.
4. [Display recovery requirement](docs/display.md)
5. [Build notes](docs/building.md)
6. [Agent behavior](docs/agent.md) and [installation](docs/agent-install.md)
7. [Web-only delivery plan](docs/web-only-delivery-plan.md) and [web Console security](docs/web-console-security.md)
8. [Shared contracts](docs/contracts.md)
9. [Security invariants](docs/security-invariants.md)
10. [Location topology](docs/topology.md)
11. [Telemetry and retention](docs/check-in-tiers.md)
12. [Data residency](docs/data-residency.md) and [time zones](docs/time-zones.md)

The component documents are being reconciled with the audit. Treat an unverified safety claim in those documents as a requirement to test, not deployment approval. The release gates take precedence over historical claims of readiness.

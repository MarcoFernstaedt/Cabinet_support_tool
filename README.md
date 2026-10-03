# Cabinet Support Tool

An internal Cabinet Support product. Staff use a browser-based support Console to inspect cabinets and request only approved operations. Each cabinet runs a Windows Agent service; there is no desktop Console delivery target.

Production release is blocked while the audited defects are repaired and Windows lab testing is completed. See the [current build tracker](docs/build-tracker.md) and [release gates](docs/readiness.md). Passing automated tests does not establish that a cabinet is safe to deploy.

## Where it runs

Mashura hosts the support API, its database and the target same-origin web Console. Staff use a browser. Each customer cabinet runs a Windows Agent service that initiates outbound connections to the API.

Clients can have multiple locations and several cabinets at each location. Typically one cabinet holds the location's application database and acts as the sync cabinet. Other cabinets communicate with it locally. The Mashura support server does not replace or read that application database.

The target placement and trust boundaries are in [architecture](docs/architecture.md). Older SVG placement diagrams depict a historical desktop Console, not the delivery architecture.

## Scope

The current release composition is monitoring only: process and event observations, inventory and storage health. Legacy `Demo` and `Maintenance` settings cannot enable cabinet mutations or update scheduling. Historical control implementations remain for safety regression tests in a separate, non-distributable build configuration. See the [compiled monitoring boundary](docs/restricted-demo-mode.md) for the exact allowlist and both test lanes. Future governed updates require a separately reviewed release.

Physical cabinet sensors, drawer opening, lock release and cubie opening remain excluded. The Windows support scope does not permit arbitrary shell commands, scripts or access to patient records.

## Projects

1. `CabinetPlatform.Contracts` defines the messages shared across processes.
2. `CabinetPlatform.Agent` collects machine information and performs named Windows actions through typed gateways.
3. `CabinetPlatform.Server` owns support authorization, device registration, topology, approvals and result storage.
4. `CabinetPlatform.Web` is a loopback-only synthetic-data preview, not an approved staff deployment.
5. `CabinetPlatform.WebHost` currently provides a fail-closed Entra sign-in boundary, not yet an authorized cabinet-data BFF. Integrating it with the web Console is a release gate.

Historical `CabinetPlatform.Console.Core` and `CabinetPlatform.Console` projects remain temporarily for safety-test reference. They are not a product milestone or fallback requirement. Once equivalent web behavior and safety tests are accepted, remove them and all retired delivery references through the tracked G08 cleanup.

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

Read the [current capability status](docs/capabilities.md) for implemented behavior, incomplete wiring and verification limits.

1. [Product requirements](docs/requirements.md)
2. [Architecture and data flow](docs/architecture.md)
3. [Release gates](docs/readiness.md), [isolated demo setup](docs/demo.md) and [Windows demo checks](docs/testing.md)
4. [Display recovery requirement](docs/display.md)
5. [Build notes](docs/building.md)
6. [Agent behavior](docs/agent.md) and [installation](docs/agent-install.md)
7. [Web-only delivery plan](docs/web-only-delivery-plan.md) and [web Console security](docs/web-console-security.md); [historical WPF Console](docs/console.md)
8. [Shared contracts](docs/contracts.md)
9. [Security invariants](docs/security-invariants.md)
10. [Location topology](docs/topology.md)
11. [Telemetry and retention](docs/check-in-tiers.md)
12. [Data residency](docs/data-residency.md) and [time zones](docs/time-zones.md)

The component documents are being reconciled with the audit. Treat an unverified safety claim in those documents as a requirement to test, not deployment approval. The release gates take precedence over historical claims of readiness.

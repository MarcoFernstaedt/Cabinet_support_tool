# Building

The .NET version is set once, in `Directory.Build.props`, and inherited by
every project. No project restates it.

```
dotnet build CabinetPlatform.sln
dotnet test tests/CabinetPlatform.Server.Tests -c Release --filter FullyQualifiedName~MonitoringBoundaryTests
dotnet test tests/CabinetPlatform.Agent.Tests -c Release --filter "FullyQualifiedName~MonitoringBoundaryTests|FullyQualifiedName~DiagnosticDemoTests"
```

## Platform requirements

`CabinetPlatform.Console` is a WPF application and targets `net8.0-windows`.
It builds only on Windows, or on a machine whose .NET SDK ships the
`Microsoft.NET.Sdk.WindowsDesktop` targets. On a Linux SDK that omits them the
project restores but cannot compile, and a whole-solution build reports:

```
error MSB4019: The imported project ".../Microsoft.NET.Sdk.WindowsDesktop/targets/
Microsoft.NET.Sdk.WindowsDesktop.targets" was not found.
```

`CabinetPlatform.Agent` also targets `net8.0-windows`, because it reads WMI,
the registry, the Windows event log and the service control manager. Unlike the
WPF console it needs no desktop targets, so `EnableWindowsTargeting` in
`Directory.Build.props` is enough to build and test it on Linux CI. Only
*running* it against real hardware requires Windows.

Everything except the WPF console builds and tests anywhere:

```
dotnet build src/CabinetPlatform.Contracts/CabinetPlatform.Contracts.csproj
dotnet build src/CabinetPlatform.Agent/CabinetPlatform.Agent.csproj
dotnet build src/CabinetPlatform.Server/CabinetPlatform.Server.csproj
dotnet test tests/CabinetPlatform.Server.Tests -c LegacyMaintenanceTests
dotnet test tests/CabinetPlatform.Agent.Tests -c LegacyMaintenanceTests
dotnet test tests/CabinetPlatform.Console.Core.Tests -c LegacyMaintenanceTests
```

`Debug` and `Release` compile the monitoring-only boundary. Run the monitoring
tests above against the actual release composition. The historical full suites
retain their maintenance expectations and require the explicit
`LegacyMaintenanceTests` configuration, with separate build outputs and blocked
publish/pack targets. Do not distribute that test build or mistake its passing
tests for monitoring-release acceptance. See [compiled monitoring boundary](restricted-demo-mode.md).

The agent's tests run on a non-Windows machine because the code under test
reaches Windows only through injected interfaces. That is a design property
worth preserving: a collector that called WMI from a static helper could only
be tested on a cabinet, which in practice means it would not be tested.

## Warnings are errors

`TreatWarningsAsErrors` is on for every project. `CabinetPlatform.Contracts`
also generates its documentation file, which makes an undocumented public
member a build error — the contracts are the shared surface between three
executables and are documented as such.

## Configuration

Settings live in `appsettings.json`, never in source: the agent's server URL
and check-in interval, the server's connection string and log sinks. Use
`dotnet user-secrets` for anything sensitive during local development. No
secrets and no plaintext passwords belong in this repository.

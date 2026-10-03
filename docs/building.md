# Building the browser Console, Server and Windows Agent

The operator Console is a browser app. Windows ships only `CabinetPlatform.Agent` as a service. `CabinetPlatform.Console.Core` is temporarily retained as a test dependency for Agent transport regressions, **not** a release artifact or operator application. Its removal requires moving those tests without losing their safety assertions.

The SDK target is inherited from `Directory.Build.props`. With the .NET 8 SDK:

```sh
dotnet build CabinetPlatform.sln -c Release
dotnet test tests/CabinetPlatform.Server.Tests -c Release
dotnet test tests/CabinetPlatform.Agent.Tests -c Release
dotnet test tests/CabinetPlatform.WebHost.Tests -c Release
dotnet test tests/CabinetPlatform.DemoBff.Tests -c Release
python3 -m unittest discover -s tests/office-bootstrap -v
```

The Agent targets Windows APIs but can build and run its injected-interface tests on Linux. Native Windows service installation, SCM behavior, ACLs and actual cabinet readings require separate HP verification. The web source in `src/CabinetPlatform.Web` has its own JavaScript tests and is not a replacement for live authenticated browser acceptance.

Historical `LegacyMaintenanceTests` are a nonshipping test configuration; never publish or install those outputs. The Console.Core tests retain legacy transport and action-policy coverage, including known historical failures; they are not a Windows desktop release gate. Do not delete that coverage merely to make a solution test green.

`tools/prepare_office_demo.py` prepares an unsigned private Agent staging bundle and short-lived lab enrollment tokens. `tools/build_independent_demo_kit.py` packages an Agent-only Windows ZIP from a clean committed revision. Neither script enrolls the HP or changes the running Server. See [office bootstrap](office-bootstrap.md) and [independent kit](independent-demo-kit.md) for restrictions.

`TreatWarningsAsErrors` applies to the managed projects. Keep passwords, device keys and tokens out of source; use appropriate protected local configuration and the approved Server/Agent deployment procedure.

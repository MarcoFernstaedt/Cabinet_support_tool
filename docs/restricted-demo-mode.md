# Compiled monitoring boundary

The current monitoring spec supersedes the former process-control demo. Ordinary `Debug` and `Release` builds are observation only. Old `Actions:ExecutionMode` and `Agent:Actions:ExecutionMode` values, including `Demo` and `Maintenance`, cannot restore mutation capabilities. Roles, supervisor overrides, old approvals and persisted schedules cannot expand this compiled ceiling.

## Allowed surface

Only `GetProcessList`, `CollectEventLogs`, `RunEventLogView` and `GetScheduledUpdates` are allowed actions. The last action reads retained schedule evidence; it does not make that schedule eligible to run. Routine inventory collection remains available, including offline update metadata queries. Online update scans, scheduling, cancellation, installation, reboot, process termination/launch, service control, network changes, arbitrary shell/scripts and hardware actuation are not available actions in this release. There is no generic executor fallback.

The server applies this boundary to catalog visibility, direct and batch requests, single and batch approvals, and queued dispatch. Previously approved mutations are durably cancelled when polled. Pending mutations cannot be approved. The agent independently refuses disallowed actions even if an executor is injected, and its shipping DI composition registers only the four observational executors.

The startup recovery and periodic scheduled-install runner remain callable, but maintenance eligibility is compiled off. Due schedules and network rollback records stay intact. An unconfirmed network change needs explicit on-site reconciliation; the monitoring agent does not restore, clear or silently forget it. Existing action-journal interrupted-result reporting remains unchanged and never resumes execution.

## Historical safety regression build

`LegacyMaintenanceTests` is a separate, explicitly named compile configuration for existing maintenance safety tests. It preserves their original expectations rather than changing assertions to call denied operations successful. Its artifacts live under separate configuration-specific `bin` and `obj` paths. Publishing and packing this configuration fail with a build error. Do not distribute or execute these test artifacts against cabinets. Native gateway implementations and historical executor classes remain in source and assemblies for regression testing; the shipping composition does not register their action executors. This is a composition boundary, not a privileged-process sandbox or a defense against replacement of trusted binaries.

Run from the repository root with the .NET 8 SDK (add `-m:1` on constrained hosts):

```text
dotnet test tests/CabinetPlatform.Server.Tests -c Release -m:1 --filter FullyQualifiedName~MonitoringBoundaryTests
dotnet test tests/CabinetPlatform.Agent.Tests -c Release -m:1 --filter "FullyQualifiedName~MonitoringBoundaryTests|FullyQualifiedName~DiagnosticDemoTests"
dotnet test tests/CabinetPlatform.Server.Tests -c LegacyMaintenanceTests -m:1
dotnet test tests/CabinetPlatform.Agent.Tests -c LegacyMaintenanceTests -m:1
dotnet test tests/CabinetPlatform.Console.Core.Tests -c LegacyMaintenanceTests -m:1
```

The new boundary tests are compiled only in monitoring configurations. The full historical suites deliberately require `LegacyMaintenanceTests`; an unfiltered run of those old control expectations in `Release` is not a supported regression command. A passing historical suite is not proof of the shipping boundary: run both lanes, and never use `--no-build` to interchange configurations.

## Evidence and remaining gates

`MonitoringBoundaryTests` exercises authenticated requests, batches, approval refusal and persisted mutation cancellation with legacy configuration while a following observation still dispatches. Agent tests inject recording executors for every action and reopen real disk-backed schedule and rollback stores, checking that startup leaves bytes unchanged and invokes no install or restore effect. `DiagnosticDemoTests` exercises observation collection and result transport with synthetic native inputs.

These tests do not establish Windows 10/11 native acceptance, WPF interaction, device authentication, MFA, site authorization, event-data confidentiality, PostgreSQL fleet capacity or production readiness. Only use synthetic authorized lab data until those separate gaps are closed. Future governed updates require a separately reviewed release; restoring the historical configuration is not that release.

Do not roll back to a legacy control-enabled artifact while retained schedules or rollback journals exist. Preserve them and arrange explicit reconciliation first. Rolling back this source change restores the old configuration-sensitive behavior, not a safe monitoring fallback.

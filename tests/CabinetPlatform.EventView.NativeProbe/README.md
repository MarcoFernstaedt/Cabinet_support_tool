# Event view native probe

This standalone executable references the unchanged Agent implementation. It does not start the service host or load Agent configuration. No server access, credentials, event writes, permission changes or channel configuration changes are involved. It emits query text, counts, outcomes, exception types and numeric error codes only. Event messages, XML, timestamps, user names and machine identifiers are never emitted.

The fixed fixture mirrors DatabaseSeeder's Disk and storage view, with the operator's one-hour override. This is not a readback of the mutable live saved view. Confirm the live definition matches before treating a native result as the exact incident reproduction.

Build on Linux:

    /home/marco/tmp/cabinet-audit-dotnet/dotnet build tests/CabinetPlatform.EventView.NativeProbe -m:1
    /home/marco/tmp/cabinet-audit-dotnet/dotnet tests/CabinetPlatform.EventView.NativeProbe/bin/Debug/net8.0-windows/CabinetPlatform.EventView.NativeProbe.dll synthetic
    /home/marco/tmp/cabinet-audit-dotnet/dotnet publish tests/CabinetPlatform.EventView.NativeProbe -c Release -r win-x64 --self-contained true -m:1 -o /home/marco/tmp/cabinet-eventview-native-probe

Use Run-Probe.ps1 from a disposable extracted directory on Windows. The parent owns approved delivery and execution. Do not replace installed Agent files or run CabinetPlatform.Agent.exe. Run-Probe starts only CabinetPlatform.EventView.NativeProbe.exe, clears inherited environment except Windows/temp paths, and applies a 30-second external deadline to each child. It terminates only its own diagnostic child on timeout. Its evidence folder is unique per invocation.

Modes:

- synthetic: real RunViewResult with injected empty and failing sources. Confirms empty Readable is distinct from empty Unavailable. This is not a native pass.
- broad: same severity/time predicate as broad collection, without providers or IDs. Also samples legacy Read, explicitly noting its exception-swallowing limitation.
- disk: repository's seeded filter with one-hour override.
- no-providers / no-ids / one-provider: isolate query predicates.
- empty-control: nonexistent synthetic provider; success must be a readable empty result, not Unavailable.
- invalid-query: intentionally malformed query. Expected exit 3 only when native EvtQuery returns ERROR_EVT_INVALID_QUERY (15001) and managed reader rejects it. A different failure is exit 1, not an accepted control.

Each native mode first probes EvtQuery directly, then channel configuration and a two-record managed sample, then the actual WindowsEventRecordGateway and RunViewResult (up to the fixture's 500-record cap). The gateway wrapper observes exception type/HResult and rethrows; it does not translate failure to success. Per-channel results remain visible.

A native mode returns 0 only when configuration is enabled, the managed sample completed and the product reports readable channel outcomes. Nonzero and timeout evidence must be retained. A readable empty Disk view does not establish disk health. Synthetic passes and cross-compilation do not certify Windows query syntax or HP service-context permissions. Interactive and LocalSystem identity differ; do not modify ACLs to make a probe pass.

The PowerShell runner itself requires Windows validation. Keep service-context reproduction, exact live definition comparison, independent review, saved-view end-to-end rerun and release gating with the parent. No product fix is included until native evidence establishes a cause.

using System.Diagnostics;
using System.Text.Json;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>On-demand, fixed window WER metadata observation. Production native calls run in a disposable child.</summary>
public sealed class GetWerMetadataExecutor : IActionExecutor
{
    private readonly IWerMetadataGateway? gateway;
    private readonly IWerResultProbe? probe;
    private readonly IClock? clock;
    public GetWerMetadataExecutor(IWerMetadataGateway gateway, IClock clock)
    { this.gateway = gateway; this.clock = clock; }
    public GetWerMetadataExecutor(IWerResultProbe probe) => this.probe = probe;
    private const int MaxKeysPerStore = 128;
    private const int MaxRows = 40;
    private static readonly TimeSpan Window = TimeSpan.FromDays(7);
    private static readonly TimeSpan Budget = TimeSpan.FromSeconds(3);
    public ActionName Action => ActionName.GetWerMetadata;

    public async Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, [], out _))
            return ActionOutcome.Denied("WER metadata accepts no parameters.");
        cancellationToken.ThrowIfCancellationRequested();
        if (probe is not null)
        {
            var isolated = await probe.ReadAsync(cancellationToken).ConfigureAwait(false);
            return ActionOutcome.Collected("WER metadata observation complete; no report content collected.",
                JsonSerializer.Serialize(isolated, AgentJson.SerializerOptions));
        }
        var observed = clock!.UtcNow.ToUniversalTime();
        var elapsed = Stopwatch.StartNew();
        var rows = new List<WerReportObservation>();
        var stores = new List<WerStoreObservation>();
        var ids = new HashSet<Guid>();
        foreach (var store in new[] { WerStore.MachineQueue, WerStore.MachineArchive })
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (elapsed.Elapsed >= Budget || rows.Count >= MaxRows)
            {
                stores.Add(new WerStoreObservation { Store = store, Status = WerStoreStatus.Partial, Truncated = true });
                continue;
            }
            int visited = 0;
            bool truncated = false;
            WerStoreStatus status = WerStoreStatus.Read;
            try
            {
                // Conservative truncation at the boundary avoids native look-ahead queries.
                foreach (var native in gateway!.Enumerate(store, cancellationToken))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (elapsed.Elapsed >= Budget || visited >= MaxKeysPerStore || rows.Count >= MaxRows)
                    {
                        truncated = true;
                        break;
                    }
                    visited++;
                    if (native.ReportId != Guid.Empty && native.CreatedUtc.Offset == TimeSpan.Zero &&
                        native.CreatedUtc <= observed && native.CreatedUtc >= observed - Window &&
                        TryApproveEventType(native.EventName, out var eventType) && ids.Add(native.ReportId))
                        rows.Add(new WerReportObservation { ReportId = native.ReportId,
                            CreatedUtc = native.CreatedUtc, EventType = eventType, Store = store });
                    if (rows.Count >= MaxRows || visited >= MaxKeysPerStore)
                    {
                        truncated = true; // Conservatively incomplete: do not query a look-ahead row.
                        break;
                    }
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (TimeoutException) { truncated = true; status = WerStoreStatus.Partial; }
            catch (UnauthorizedAccessException) { status = visited > 0 ? WerStoreStatus.Partial : WerStoreStatus.Denied; }
            catch (Exception) { status = visited > 0 ? WerStoreStatus.Partial : WerStoreStatus.Unavailable; }
            if (truncated) status = WerStoreStatus.Partial;
            stores.Add(new WerStoreObservation { Store = store, Status = status, Truncated = truncated });
        }
        var result = new WerMetadataResult { ObservedUtc = observed, Reports = rows, Stores = stores };
        return ActionOutcome.Collected("WER metadata observation complete; no report content collected.",
            JsonSerializer.Serialize(result, AgentJson.SerializerOptions));
    }

    private static bool TryApproveEventType(string? name, out string approved)
    {
        // Native event names are untrusted; emit only compiled literals, never native spelling.
        approved = name switch
        {
            "APPCRASH" => "APPCRASH",
            "BEX" => "BEX",
            "BEX64" => "BEX64",
            "CLR20r3" => "CLR20r3",
            "MoAppCrash" => "MoAppCrash",
            "AppHangB1" => "AppHangB1",
            _ => string.Empty
        };
        return approved.Length != 0;
    }
}

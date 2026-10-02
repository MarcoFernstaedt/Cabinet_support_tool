using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Text.Json;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Actions.Executors;

public sealed class GetHistoricalProcessEvidenceExecutor : IActionExecutor
{
    private readonly IHistoricalProcessGateway? gateway;
    private readonly IClock? clock;
    private readonly IHistoricalProcessProbe? probe;
    public GetHistoricalProcessEvidenceExecutor(IHistoricalProcessGateway gateway, IClock clock)
    { this.gateway = gateway; this.clock = clock; }
    public GetHistoricalProcessEvidenceExecutor(IHistoricalProcessProbe probe) => this.probe = probe;
    public ActionName Action => ActionName.GetHistoricalProcessEvidence;
    public async Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, [], out _))
            return ActionOutcome.Denied("Historical process evidence accepts no parameters.");
        cancellationToken.ThrowIfCancellationRequested();
        HistoricalProcessEvidenceResult result;
        if (probe is not null)
        {
            try { result = await probe.ReadAsync(cancellationToken).ConfigureAwait(false); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                var now = DateTimeOffset.UtcNow;
                result = new HistoricalProcessEvidenceResult
                {
                    ObservedUtc = now, WindowStartUtc = now.AddDays(-1),
                    Status = ex is TimeoutException ? ProcessEvidenceStatus.Partial :
                        ex is UnauthorizedAccessException ? ProcessEvidenceStatus.Denied : ProcessEvidenceStatus.Unavailable,
                    Truncated = ex is TimeoutException
                };
            }
        }
        else
        {
            var now = clock!.UtcNow.ToUniversalTime();
            var since = now.AddDays(-1);
            var rows = new List<HistoricalProcessEvent>();
            var status = ProcessEvidenceStatus.Read;
            var truncated = false;
            var timer = Stopwatch.StartNew();
            try
            {
                using var nativeRows = gateway!.Read(since, now, cancellationToken).GetEnumerator();
                // Do not advance the native cursor to discover whether a capped result has more.
                while (true)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (timer.Elapsed >= TimeSpan.FromSeconds(3) || rows.Count >= 64)
                    { truncated = true; status = ProcessEvidenceStatus.Partial; break; }
                    if (!nativeRows.MoveNext()) break;
                    if (timer.Elapsed >= TimeSpan.FromSeconds(3))
                    { truncated = true; status = ProcessEvidenceStatus.Partial; break; }
                    var native = nativeRows.Current;
                    if (native.Provider != "Microsoft-Windows-Security-Auditing" ||
                        native.EventId is not (4688 or 4689) || native.OccurredUtc.Offset != TimeSpan.Zero ||
                        native.OccurredUtc < since || native.OccurredUtc > now)
                    { status = ProcessEvidenceStatus.Partial; continue; }
                    var pid = HistoricalProcessEventParser.ParsePid(native.Xml, native.EventId);
                    if (pid is null) { status = ProcessEvidenceStatus.Partial; continue; }
                    rows.Add(new HistoricalProcessEvent
                    {
                        OccurredUtc = native.OccurredUtc, Kind = native.EventId == 4688 ? ProcessEventKind.Start : ProcessEventKind.Exit,
                        ProcessId = pid.Value, RecordId = native.RecordId is > 0 ? native.RecordId : null
                    });
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                status = ex switch
                {
                    HistoricalProcessLimitException or TimeoutException => ProcessEvidenceStatus.Partial,
                    EventLogException when unchecked((uint)ex.HResult) == 0x800705B4 => ProcessEvidenceStatus.Partial,
                    EventLogException when unchecked((uint)ex.HResult) == 0x80070005 && rows.Count == 0 => ProcessEvidenceStatus.Denied,
                    UnauthorizedAccessException when rows.Count == 0 => ProcessEvidenceStatus.Denied,
                    _ when rows.Count != 0 => ProcessEvidenceStatus.Partial,
                    _ => ProcessEvidenceStatus.Unavailable
                };
                truncated |= ex is HistoricalProcessLimitException or TimeoutException ||
                    ex is EventLogException && unchecked((uint)ex.HResult) == 0x800705B4;
            }
            result = new HistoricalProcessEvidenceResult { ObservedUtc = now, WindowStartUtc = since,
                Status = status, Truncated = truncated, Events = rows };
        }
        return ActionOutcome.Collected("Historical process lifecycle observation; audit coverage and cause unverified.",
            JsonSerializer.Serialize(result, AgentJson.SerializerOptions));
    }
}

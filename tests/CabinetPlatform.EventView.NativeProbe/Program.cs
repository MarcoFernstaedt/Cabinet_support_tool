using System.Diagnostics.Eventing.Reader;
using System.Text.Json;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;
using ProductReader = CabinetPlatform.Agent.Platform.EventLogReader;
using NativeReader = System.Diagnostics.Eventing.Reader.EventLogReader;

// Standalone diagnostics only: never starts the Agent host, loads configuration,
// contacts a server, writes events, enables a channel, or prints event contents.
var mode = args.SingleOrDefault() ?? "synthetic";
var definition = new EventLogViewDefinition
{
    ViewId = Guid.Parse("00000000-0000-0000-0000-000000000001"),
    DisplayName = "Disk and storage", LogNames = new[] { EventLogName.System },
    Sources = new[] { "disk", "Disk", "Ntfs", "storahci", "stornvme", "volmgr",
        "Microsoft-Windows-Ntfs", "Microsoft-Windows-StorageSpaces-Driver" },
    EventIds = new[] { 7, 11, 51, 52, 98, 153 }, MinimumLevel = EventLogLevel.Warning,
    WindowHours = 1, MaximumEntries = 500
};
if (mode == "synthetic")
{
    // These deliberately exercise the real aggregation seam without claiming native acceptance.
    foreach (var failure in new[] { false, true })
    {
        var reader = new ProductReader(NullLogger<ProductReader>.Instance, new NoDiscovery(),
            records: new SyntheticRecords(failure));
        var result = reader.RunViewResult(definition, default);
        var expected = failure ? EventChannelAccess.Unavailable : EventChannelAccess.Readable;
        if (result.ChannelReads?.Single().Access != expected || result.Entries.Count != 0)
            return 1;
        Emit(new { mode, injectedFailure = failure, access = expected.ToString(), records = 0 });
    }
    Emit(new { mode, query = EventLogViewQueryBuilder.Build(definition, TimeSpan.FromHours(1)) });
    return 0;
}
if (mode is "executor" or "executor-after-discovery" or "diagnostic" or "diagnostic-after-discovery")
    return await ExecutorProbe.RunAsync(mode, definition);
if (!OperatingSystem.IsWindows()) { Emit(new { mode, blocked = "Windows required" }); return 2; }
if (mode == "no-providers") definition = definition with { Sources = Array.Empty<string>() };
else if (mode == "no-ids") definition = definition with { EventIds = Array.Empty<int>() };
else if (mode == "broad") definition = definition with { Sources = Array.Empty<string>(), EventIds = Array.Empty<int>() };
else if (mode == "one-provider") definition = definition with { Sources = new[] { "disk" } };
else if (mode == "empty-control") definition = definition with { Sources = new[] { "CabinetSyntheticProviderThatDoesNotExist" } };
else if (mode is not ("disk" or "invalid-query")) { Emit(new { mode, blocked = "Unknown mode" }); return 2; }
var queryText = mode == "invalid-query" ? "*[System[" : EventLogViewQueryBuilder.Build(definition, TimeSpan.FromHours(1));
if (mode == "broad")
{
    try
    {
        var legacyReader = new ProductReader(NullLogger<ProductReader>.Instance);
        var legacy = legacyReader.Read(EventLogName.System, TimeSpan.FromHours(1), 2, default);
        Emit(new { mode, stage = "legacy-broad", sampledRecords = legacy.Count, sampleLimit = 2,
            caveat = "Legacy Read can swallow a mid-stream EventLogException; this is not an independent clean-read proof." });
    }
    catch (Exception e) { Failure(mode, "legacy-broad", e); }
}
Emit(new { mode, query = queryText });
// Independent native query parsing gives the exact Win32 error without disclosing error text.
var queryHandle = NativeMethods.EvtQuery(IntPtr.Zero, "System", queryText, 0x201);
var queryError = queryHandle == IntPtr.Zero ? System.Runtime.InteropServices.Marshal.GetLastWin32Error() : 0;
if (queryHandle != IntPtr.Zero) NativeMethods.EvtClose(queryHandle);
Emit(new { mode, stage = "EvtQuery", win32ErrorCode = queryError });
var stage = "configuration";
bool directOk = false;
bool configurationOk = false;
try
{
    using var configuration = new EventLogConfiguration("System");
    configurationOk = configuration.IsEnabled;
    Emit(new { mode, stage, enabled = configurationOk });
}
catch (Exception e) { Failure(mode, stage, e); }
try
{
    stage = "query-construction";
    var query = new EventLogQuery("System", PathType.LogName, queryText)
        { ReverseDirection = true, TolerateQueryErrors = false };
    stage = "reader-construction";
    using var native = new NativeReader(query) { BatchSize = 1 };
    var count = 0;
    while (count < 2)
    {
        stage = "read-event";
        using var record = native.ReadEvent(TimeSpan.FromMilliseconds(100));
        if (record is null) break;
        // Force the same native property accesses as the product, without printing values.
        stage = "record-properties";
        _ = record.TimeCreated; _ = record.LogName; _ = record.ProviderName; _ = record.Id; _ = record.Level;
        stage = "format-description";
        try { _ = record.FormatDescription(); } catch (EventLogException) { }
        count++;
    }
    directOk = true;
    Emit(new { mode, stage = "direct-complete", sampledRecords = count, sampleLimit = 2 });
}
catch (Exception e) { Failure(mode, stage, e); }
if (mode == "invalid-query") return !directOk && queryError == 15001 ? 3 : 1; // ERROR_EVT_INVALID_QUERY.
var recording = new RecordingRecords();
var product = new ProductReader(NullLogger<ProductReader>.Instance, new NoDiscovery(), records: recording);
var view = product.RunViewResult(definition, default);
Emit(new { mode, stage = "product-result", entries = view.Entries.Count,
    outcomes = view.ChannelReads?.Select(c => new { c.Name, access = c.Access.ToString(), c.RecordsRead, c.Truncated }),
    view.Truncated });
return queryError == 0 && configurationOk && directOk &&
    (mode != "empty-control" || view.Entries.Count == 0) &&
    view.ChannelReads?.All(c => c.Access == EventChannelAccess.Readable) == true ? 0 : 1;

static void Emit(object value) => Console.WriteLine(JsonSerializer.Serialize(value));
static void Failure(string mode, string stage, Exception e) => Emit(new
{
    mode, stage, exceptionType = e.GetType().FullName, hresult = $"0x{e.HResult:X8}",
    // No exception message, stack, record XML, user identity, or machine identity.
    win32ErrorCode = e is System.ComponentModel.Win32Exception win32 ? (int?)win32.NativeErrorCode : null
});

static class NativeMethods
{
    [System.Runtime.InteropServices.DllImport("wevtapi.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr EvtQuery(IntPtr session, string path, string query, int flags);
    [System.Runtime.InteropServices.DllImport("wevtapi.dll")]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    internal static extern bool EvtClose(IntPtr handle);
}

sealed class NoDiscovery : IEventChannelGateway
{
    public IEnumerable<string> GetChannelNames(CancellationToken token) => Array.Empty<string>();
    public EventChannelAccess Probe(string name, CancellationToken token) => throw new NotSupportedException();
}
sealed class SyntheticRecords(bool fail) : IEventRecordGateway
{
    public IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken token)
        => fail ? throw new InvalidOperationException("Synthetic unavailable") : Array.Empty<EventLogEntry>();
}
sealed class RecordingRecords : IEventRecordGateway
{
    public IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken token)
    {
        using var iterator = new WindowsEventRecordGateway().Read(channel, definition, token).GetEnumerator();
        while (true)
        {
            bool next;
            try { next = iterator.MoveNext(); }
            catch (Exception e)
            {
                Console.WriteLine(JsonSerializer.Serialize(new { stage = "product-gateway", exceptionType = e.GetType().FullName,
                    hresult = $"0x{e.HResult:X8}", win32ErrorCode = e is System.ComponentModel.Win32Exception win32 ? (int?)win32.NativeErrorCode : null }));
                throw;
            }
            if (!next) yield break;
            yield return iterator.Current;
        }
    }
}

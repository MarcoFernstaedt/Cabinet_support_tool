using System.Runtime.Versioning;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Reads the Windows Update Agent through its COM API.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsUpdateGateway : IWindowsUpdateGateway
{
    private const string UpdateSessionProgId = "Microsoft.Update.Session";

    /// <summary>
    /// Applicable updates that are not installed. This is a search, not an
    /// install: it changes nothing on the machine.
    /// </summary>
    private const string PendingSearchCriteria = "IsInstalled=0 and IsHidden=0";

    private readonly ILogger<WindowsUpdateGateway> _logger;

    public WindowsUpdateGateway(ILogger<WindowsUpdateGateway> logger) => _logger = logger;

    public IReadOnlyList<PendingUpdateInfo> SearchPendingUpdates(bool online, CancellationToken cancellationToken)
    {
        using var session = CreateSession();
        using var searcher = session.InvokeObject("CreateUpdateSearcher")
            ?? throw new InvalidOperationException("The Windows Update Agent returned no update searcher.");

        // An online search asks Windows Update for a fresh answer and can take
        // minutes; an offline one reads what Windows already knows and returns
        // at once. The caller chooses, because the right answer differs between
        // a routine check-in and somebody explicitly asking a cabinet to scan.
        searcher.SetValue("Online", online);

        cancellationToken.ThrowIfCancellationRequested();

        using var searchResult = searcher.InvokeObject("Search", PendingSearchCriteria)
            ?? throw new InvalidOperationException("The Windows Update Agent returned no search result.");

        using var updates = searchResult.GetObject("Updates");
        if (updates is null)
        {
            return Array.Empty<PendingUpdateInfo>();
        }

        var pending = new List<PendingUpdateInfo>();

        foreach (var update in updates.EnumerateCollection())
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                pending.Add(ToPendingUpdate(update));
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _logger.LogDebug(e, "A pending update entry could not be read.");
            }
        }

        return pending;
    }

    public IReadOnlyList<UpdateHistoryEntry> GetHistory(int maximumEntries, CancellationToken cancellationToken)
    {
        if (maximumEntries <= 0)
        {
            return Array.Empty<UpdateHistoryEntry>();
        }

        using var session = CreateSession();
        using var searcher = session.InvokeObject("CreateUpdateSearcher")
            ?? throw new InvalidOperationException("The Windows Update Agent returned no update searcher.");

        var totalCount = searcher.Invoke("GetTotalHistoryCount") is { } raw
            ? Convert.ToInt32(raw)
            : 0;

        if (totalCount <= 0)
        {
            return Array.Empty<UpdateHistoryEntry>();
        }

        var count = Math.Min(maximumEntries, totalCount);

        // QueryHistory is ordered newest first, so index 0 is the most recent.
        using var history = searcher.InvokeObject("QueryHistory", 0, count);
        if (history is null)
        {
            return Array.Empty<UpdateHistoryEntry>();
        }

        var entries = new List<UpdateHistoryEntry>(count);

        foreach (var record in history.EnumerateCollection())
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                var errorCode = record.GetInt32("HResult");

                entries.Add(new UpdateHistoryEntry
                {
                    Title = record.GetString("Title"),
                    ResultCode = WindowsUpdateResultMapping.MapResultCode(record.GetInt32("ResultCode")),
                    DateUtc = record.GetDateTime("Date"),

                    // 0 is success, not an error code worth reporting.
                    ErrorCode = errorCode is 0 or null ? null : errorCode,
                });
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _logger.LogDebug(e, "An update history entry could not be read.");
            }
        }

        return entries;
    }

    private static ComObject CreateSession()
        => ComObject.CreateFromProgId(UpdateSessionProgId)
           ?? throw new InvalidOperationException(
               $"The Windows Update Agent COM class '{UpdateSessionProgId}' is not registered on this machine.");

    private static PendingUpdateInfo ToPendingUpdate(ComObject update)
    {
        using var identity = update.GetObject("Identity");
        var updateId = identity?.GetString("UpdateID");

        var categoryNames = new List<string?>();
        using (var categories = update.GetObject("Categories"))
        {
            if (categories is not null)
            {
                foreach (var category in categories.EnumerateCollection())
                {
                    categoryNames.Add(category.GetString("Name"));
                }
            }
        }

        var severity = update.GetString("MsrcSeverity");
        var classification = WindowsUpdateResultMapping.SelectClassification(categoryNames);

        return new PendingUpdateInfo
        {
            // An update with no identity cannot be referred to later, so it is
            // given a stable placeholder rather than being dropped silently.
            UpdateId = updateId ?? "(unknown)",
            Title = update.GetString("Title"),
            Classification = classification,

            // An MSRC severity is only assigned to security updates, so its
            // presence is as good a signal as the category.
            IsSecurity = classification == UpdateClassification.SecurityUpdate
                         || !string.IsNullOrWhiteSpace(severity),

            SizeBytes = ReadSize(update),
        };
    }

    private static long? ReadSize(ComObject update)
    {
        // MaxDownloadSize is a DECIMAL over COM and can exceed what a naive
        // conversion handles, so a failure to read it is reported as unknown.
        try
        {
            return update.GetInt64("MaxDownloadSize");
        }
        catch (Exception e) when (e is InvalidCastException or OverflowException or FormatException)
        {
            return null;
        }
    }
}

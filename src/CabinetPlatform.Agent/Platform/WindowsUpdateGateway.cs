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

    /// <summary>The COM collection an install's chosen updates are put into.</summary>
    private const string UpdateCollectionProgId = "Microsoft.Update.UpdateColl";

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

    /// <inheritdoc />
    public UpdateInstallOutcome InstallUpdates(
        IReadOnlyList<string> updateIds, CancellationToken cancellationToken)
    {
        if (updateIds.Count == 0)
        {
            throw new ArgumentException(
                "An install must name the updates it is installing.", nameof(updateIds));
        }

        var wanted = new HashSet<string>(updateIds, StringComparer.OrdinalIgnoreCase);

        using ComObject session = CreateSession();
        using ComObject searcher = session.InvokeObject("CreateUpdateSearcher")
            ?? throw new InvalidOperationException("The Windows Update Agent returned no update searcher.");

        // Searched offline. The rep chose from a scan; going back to Windows
        // Update here would find a different set and install a different thing
        // from the one that was approved.
        searcher.SetValue("Online", false);

        using ComObject searchResult = searcher.InvokeObject("Search", PendingSearchCriteria)
            ?? throw new InvalidOperationException("The Windows Update Agent returned no search result.");

        using ComObject? candidates = searchResult.GetObject("Updates");

        using ComObject selected = ComObject.CreateFromProgId(UpdateCollectionProgId)
            ?? throw new InvalidOperationException(
                $"The COM class '{UpdateCollectionProgId}' is not registered on this machine.");

        var titles = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var found = new List<string>();

        if (candidates is not null)
        {
            foreach (ComObject update in candidates.EnumerateCollection())
            {
                cancellationToken.ThrowIfCancellationRequested();

                string? id = ReadUpdateId(update);

                if (id is null || !wanted.Contains(id))
                {
                    update.Dispose();
                    continue;
                }

                titles[id] = update.GetString("Title");
                found.Add(id);

                // EULAs are accepted here rather than skipped. An update the
                // machine will not install because nobody clicked through a
                // licence is an update that silently never installs.
                if (update.GetBoolean("EulaAccepted") == false)
                {
                    update.Invoke("AcceptEula");
                }

                selected.InvokeWithObject("Add", update);
                update.Dispose();
            }
        }

        DateTimeOffset completed = DateTimeOffset.UtcNow;

        // Updates the machine no longer offers are reported as not started
        // rather than dropped. "We could not find it" and "it installed" must
        // never look the same in a patch record.
        List<UpdateInstallResult> missing = wanted
            .Where(id => !found.Contains(id, StringComparer.OrdinalIgnoreCase))
            .Select(id => new UpdateInstallResult
            {
                UpdateId = id,
                Title = null,
                ResultCode = UpdateResultCode.NotStarted,
            })
            .ToList();

        if (found.Count == 0)
        {
            _logger.LogWarning(
                "None of the {RequestedCount} requested update(s) are still applicable to this machine.",
                wanted.Count);

            return new UpdateInstallOutcome
            {
                ActionRequestId = Guid.Empty,
                CompletedUtc = completed,
                Results = missing,
                RebootRequired = false,
            };
        }

        cancellationToken.ThrowIfCancellationRequested();

        using (ComObject downloader = session.InvokeObject("CreateUpdateDownloader")
                   ?? throw new InvalidOperationException(
                       "The Windows Update Agent returned no downloader."))
        {
            downloader.SetObject("Updates", selected);
            downloader.Invoke("Download");
        }

        cancellationToken.ThrowIfCancellationRequested();

        using ComObject installer = session.InvokeObject("CreateUpdateInstaller")
            ?? throw new InvalidOperationException("The Windows Update Agent returned no installer.");

        installer.SetObject("Updates", selected);

        using ComObject installResult = installer.InvokeObject("Install")
            ?? throw new InvalidOperationException("The Windows Update Agent returned no install result.");

        var results = new List<UpdateInstallResult>(found.Count);

        for (var i = 0; i < found.Count; i++)
        {
            using ComObject? perUpdate = installResult.InvokeObject("GetUpdateResult", i);

            int? hresult = perUpdate?.GetInt32("HResult");

            results.Add(new UpdateInstallResult
            {
                UpdateId = found[i],
                Title = titles.GetValueOrDefault(found[i]),
                ResultCode = WindowsUpdateResultMapping.MapResultCode(perUpdate?.GetInt32("ResultCode")),
                ErrorCode = hresult is 0 or null ? null : hresult,
            });
        }

        results.AddRange(missing);

        bool? rebootRequired = installResult.GetBoolean("RebootRequired");

        _logger.LogInformation(
            "Installed {InstalledCount} of {RequestedCount} update(s). Reboot required: {RebootRequired}.",
            results.Count(r => r.ResultCode is UpdateResultCode.Succeeded
                or UpdateResultCode.SucceededWithErrors),
            wanted.Count,
            rebootRequired);

        return new UpdateInstallOutcome
        {
            // Filled in by the executor, which is what knows the request id.
            // The gateway's job ends at what the machine did.
            ActionRequestId = Guid.Empty,
            CompletedUtc = DateTimeOffset.UtcNow,
            Results = results,
            RebootRequired = rebootRequired,
        };
    }

    /// <summary>
    /// Reads an update's identity, which the COM API nests one object deep.
    /// </summary>
    private static string? ReadUpdateId(ComObject update)
    {
        using ComObject? identity = update.GetObject("Identity");
        return identity?.GetString("UpdateID");
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

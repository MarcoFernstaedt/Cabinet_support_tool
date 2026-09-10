using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Pending updates, install history, reboot state and update policy.
/// </summary>
/// <remarks>
/// The COM half of this is slow and, on a machine part-way through servicing,
/// occasionally does not return at all. It runs on a worker thread under a
/// generous timeout so that a stuck Windows Update Agent costs this section and
/// nothing else. The registry half is cheap and always runs, so a cabinet with
/// a wedged WUA still reports that it is waiting for a reboot, which is usually
/// the reason it is wedged.
/// </remarks>
public sealed class WindowsUpdateCollector : ICollector
{
    private const string AutoUpdateRebootRequiredKey =
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired";

    private const string ComponentBasedServicingRebootPendingKey =
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending";

    private const string UpdateUxSettingsKey = @"SOFTWARE\Microsoft\WindowsUpdate\UX\Settings";

    private const string UpdatePolicyKey = @"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate";

    private const string AutoUpdatePolicyKey = @"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU";

    private const int MaximumHistoryEntries = 25;

    private readonly IWindowsUpdateGateway _gateway;
    private readonly IRegistryReader _registry;
    private readonly CollectionOptions _options;
    private readonly ILogger<WindowsUpdateCollector> _logger;

    public WindowsUpdateCollector(
        IWindowsUpdateGateway gateway,
        IRegistryReader registry,
        IOptions<AgentOptions> options,
        ILogger<WindowsUpdateCollector> logger)
    {
        _gateway = gateway;
        _registry = registry;
        _options = options.Value.Collection;
        _logger = logger;
    }

    public string SectionName => CollectorSections.WindowsUpdate;

    public async Task CollectAsync(CheckInDraft draft, CancellationToken cancellationToken)
    {
        var timeout = TimeSpan.FromSeconds(_options.WindowsUpdateTimeoutSeconds);

        var pending = await RunWithTimeoutAsync(
            () => _gateway.SearchPendingUpdates(cancellationToken),
            timeout,
            "pending update search",
            cancellationToken).ConfigureAwait(false);

        var history = await RunWithTimeoutAsync(
            () => _gateway.GetHistory(MaximumHistoryEntries, cancellationToken),
            timeout,
            "update history query",
            cancellationToken).ConfigureAwait(false);

        var (activeHoursStart, activeHoursEnd) = ReadActiveHours();
        var (isManagedByPolicy, deferralDays) = ReadPolicy();

        draft.WindowsUpdate = new WindowsUpdateInfo
        {
            PendingUpdates = pending,

            // Null rather than 0 when the search did not complete: zero pending
            // updates is what a fully patched cabinet looks like.
            PendingUpdateCount = pending?.Count,

            LastSuccessfulInstallUtc = history
                ?.Where(entry => entry.ResultCode is UpdateResultCode.Succeeded
                              or UpdateResultCode.SucceededWithErrors)
                .Max(entry => entry.DateUtc),

            RebootPending = ReadRebootPending(),
            History = history,
            ActiveHoursStart = activeHoursStart,
            ActiveHoursEnd = activeHoursEnd,
            IsManagedByPolicy = isManagedByPolicy,
            DeferralDays = deferralDays,
        };
    }

    /// <summary>
    /// Runs a blocking COM call on the thread pool and abandons it if it
    /// overruns.
    /// </summary>
    /// <returns>Null when the call failed or timed out.</returns>
    private async Task<IReadOnlyList<T>?> RunWithTimeoutAsync<T>(
        Func<IReadOnlyList<T>> operation,
        TimeSpan timeout,
        string description,
        CancellationToken cancellationToken)
    {
        try
        {
            return await Task.Run(operation, cancellationToken)
                .WaitAsync(timeout, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            // The COM call itself cannot be cancelled; the thread is left to
            // finish on its own rather than being torn down mid-call.
            _logger.LogWarning(
                "The Windows Update {Description} exceeded {TimeoutSeconds}s and was abandoned.",
                description,
                timeout.TotalSeconds);
            return null;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "The Windows Update {Description} failed.", description);
            return null;
        }
    }

    /// <summary>
    /// Reports whether Windows is waiting for a reboot.
    /// </summary>
    /// <remarks>
    /// Both keys are checked because they mean different things: Auto Update's
    /// key is set by Windows Update, while Component Based Servicing's is set by
    /// any servicing operation including a driver install. A cabinet held in
    /// either state will not finish patching until it restarts.
    /// </remarks>
    private bool ReadRebootPending()
    {
        return _registry.KeyExists(
                   RegistryHiveScope.LocalMachine,
                   AutoUpdateRebootRequiredKey,
                   RegistryViewScope.Registry64)
               || _registry.KeyExists(
                   RegistryHiveScope.LocalMachine,
                   ComponentBasedServicingRebootPendingKey,
                   RegistryViewScope.Registry64);
    }

    private (TimeOnly? Start, TimeOnly? End) ReadActiveHours()
    {
        var start = ReadHour("ActiveHoursStart");
        var end = ReadHour("ActiveHoursEnd");
        return (start, end);
    }

    private TimeOnly? ReadHour(string valueName)
    {
        var value = _registry.GetValue(
            RegistryHiveScope.LocalMachine,
            UpdateUxSettingsKey,
            valueName,
            RegistryViewScope.Registry64);

        if (value is null)
        {
            return null;
        }

        try
        {
            var hour = Convert.ToInt32(value, System.Globalization.CultureInfo.InvariantCulture);
            return hour is >= 0 and <= 23 ? new TimeOnly(hour, 0) : null;
        }
        catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException)
        {
            return null;
        }
    }

    private (bool? IsManagedByPolicy, int? DeferralDays) ReadPolicy()
    {
        var policyValues = _registry.GetValueNames(
            RegistryHiveScope.LocalMachine,
            UpdatePolicyKey,
            RegistryViewScope.Registry64);

        var autoUpdateValues = _registry.GetValueNames(
            RegistryHiveScope.LocalMachine,
            AutoUpdatePolicyKey,
            RegistryViewScope.Registry64);

        var isManaged = policyValues.Count > 0 || autoUpdateValues.Count > 0;

        // Quality updates are the ones that carry the security fixes and the
        // reboots, so their deferral is the one support needs to see.
        var deferral = ReadInt(UpdatePolicyKey, "DeferQualityUpdatesPeriodInDays")
                       ?? ReadInt(UpdatePolicyKey, "DeferFeatureUpdatesPeriodInDays");

        return (isManaged, deferral);
    }

    private int? ReadInt(string keyPath, string valueName)
    {
        var value = _registry.GetValue(
            RegistryHiveScope.LocalMachine,
            keyPath,
            valueName,
            RegistryViewScope.Registry64);

        if (value is null)
        {
            return null;
        }

        try
        {
            return Convert.ToInt32(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException)
        {
            return null;
        }
    }
}

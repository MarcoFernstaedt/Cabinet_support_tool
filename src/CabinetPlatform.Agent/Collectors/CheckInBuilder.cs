using System.Diagnostics;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Runs every collector and returns a check-in payload whatever happens.
/// </summary>
/// <remarks>
/// A partial payload is worth far more than no payload. If the Windows Update
/// COM surface hangs on a machine that is mid-servicing, that is itself a
/// symptom support wants to see — alongside the disk and event log data that
/// collected perfectly well. So each collector is isolated: its exception is
/// recorded in <see cref="CheckInPayload.SectionErrors"/> against its section
/// name and the remaining collectors still run.
/// </remarks>
public sealed class CheckInBuilder
{
    private readonly IReadOnlyList<ICollector> _collectors;
    private readonly IMachineIdentityProvider _identity;
    private readonly IAgentStateStore _stateStore;
    private readonly IClock _clock;
    private readonly ILogger<CheckInBuilder> _logger;

    private CarriedForward _carried = new(null, null);

    /// <summary>Creates the builder.</summary>
    /// <param name="collectors">Every routine collector.</param>
    /// <param name="identity">Supplies the machine id.</param>
    /// <param name="stateStore">Supplies the cabinet id once approved.</param>
    /// <param name="clock">Clock.</param>
    /// <param name="logger">Diagnostic log.</param>
    public CheckInBuilder(
        IEnumerable<ICollector> collectors,
        IMachineIdentityProvider identity,
        IAgentStateStore stateStore,
        IClock clock,
        ILogger<CheckInBuilder> logger)
    {
        _collectors = collectors.ToArray();
        _identity = identity;
        _stateStore = stateStore;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>Agent version stamped onto every payload.</summary>
    public static string AgentVersion { get; } =
        typeof(CheckInBuilder).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    /// <summary>
    /// Builds the identity-only payload sent before the server has approved
    /// this cabinet. No collector runs, so nothing diagnostic about a cabinet
    /// leaves it until an authorised person has said the cabinet is ours.
    /// </summary>
    public CheckInPayload BuildIdentityOnly()
    {
        return new CheckInPayload
        {
            AgentVersion = AgentVersion,
            MachineId = _identity.GetMachineId(),
            CabinetId = _stateStore.Load().CabinetId,
            CollectedAtUtc = _clock.UtcNow,
        };
    }

    /// <summary>
    /// Runs the collectors for one tier and assembles a payload.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A heartbeat runs only the cheap collectors. The fields it still has to
    /// carry that come from the slow ones — worst disk health, pending updates,
    /// whether a reboot is waiting — are carried forward from the last full
    /// check-in rather than re-measured, because measuring them is what makes
    /// those collectors slow.
    /// </para>
    /// <para>
    /// Carried-forward values start null and stay null until a full check-in
    /// has actually produced them. A restarted agent reports "not known yet",
    /// which is true, rather than a zero that would read as a clean bill of
    /// health.
    /// </para>
    /// </remarks>
    /// <param name="tier">Which tier to collect.</param>
    /// <param name="cancellationToken">Cancels the collection.</param>
    public async Task<CheckInPayload> BuildAsync(CheckInTier tier, CancellationToken cancellationToken)
    {
        var draft = new CheckInDraft();
        var sectionErrors = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var collector in _collectors)
        {
            if (tier == CheckInTier.Heartbeat && !collector.RunsOnHeartbeat)
            {
                continue;
            }

            // The whole check-in being cancelled is a shutdown, not a section
            // failure, and is allowed to propagate.
            cancellationToken.ThrowIfCancellationRequested();

            var stopwatch = Stopwatch.StartNew();
            try
            {
                await collector.CollectAsync(draft, tier, cancellationToken).ConfigureAwait(false);

                _logger.LogDebug(
                    "Collector {Section} completed in {ElapsedMs} ms.",
                    collector.SectionName,
                    stopwatch.ElapsedMilliseconds);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception e)
            {
                sectionErrors[collector.SectionName] = Describe(e);

                _logger.LogWarning(
                    e,
                    "Collector {Section} failed after {ElapsedMs} ms; the check-in continues without it.",
                    collector.SectionName,
                    stopwatch.ElapsedMilliseconds);
            }
        }

        if (tier == CheckInTier.Full)
        {
            // Remember what the slow collectors found, so the next few
            // heartbeats can still say something about it.
            _carried = new CarriedForward(draft.WindowsUpdate?.PendingUpdateCount,
                draft.WindowsUpdate?.RebootPending);
        }
        else
        {
            draft.WindowsUpdate = _carried.AsWindowsUpdateInfo();
        }

        return new CheckInPayload
        {
            AgentVersion = AgentVersion,
            MachineId = _identity.GetMachineId(),
            CabinetId = _stateStore.Load().CabinetId,
            CollectedAtUtc = _clock.UtcNow,
            System = draft.System,
            Performance = draft.Performance,
            Services = draft.Services,
            Disks = draft.Disks,
            EventLogs = draft.EventLogs,
            WindowsUpdate = draft.WindowsUpdate,
            Network = draft.Network,

            // Carried on every tier, not only the full one. An install
            // finishes when it finishes, which is rarely the moment a full
            // check-in happens to be due, and what a machine actually did with
            // an install is the fact the whole scheduling feature exists to
            // establish.
            UpdateInstallOutcomes = _stateStore.Load().PendingUpdateOutcomes is { Count: > 0 } outcomes
                ? outcomes
                : null,
            SectionErrors = sectionErrors,
        };
    }

    /// <summary>
    /// The handful of heartbeat fields that come from the slow tier.
    /// </summary>
    /// <remarks>
    /// Only the summary counts are carried, never the pending update list or
    /// the policy: a heartbeat that echoed those would be storing a full
    /// inventory every five minutes by the back door.
    /// </remarks>
    private sealed record CarriedForward(int? PendingUpdateCount, bool? RebootPending)
    {
        public WindowsUpdateInfo? AsWindowsUpdateInfo() =>
            PendingUpdateCount is null && RebootPending is null
                ? null
                : new WindowsUpdateInfo
                {
                    PendingUpdateCount = PendingUpdateCount,
                    RebootPending = RebootPending,
                };
    }

    /// <summary>
    /// Renders an exception for a support engineer reading the console. The
    /// type name is kept because "Access is denied" and
    /// "UnauthorizedAccessException: Access is denied" send someone looking in
    /// very different places.
    /// </summary>
    private static string Describe(Exception exception)
    {
        var message = $"{exception.GetType().Name}: {exception.Message}";
        return message.Length > 1000 ? message[..1000] : message;
    }
}

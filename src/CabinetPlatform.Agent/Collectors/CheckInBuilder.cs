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

    /// <summary>Runs every collector and assembles a full payload.</summary>
    public async Task<CheckInPayload> BuildAsync(CancellationToken cancellationToken)
    {
        var draft = new CheckInDraft();
        var sectionErrors = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var collector in _collectors)
        {
            // The whole check-in being cancelled is a shutdown, not a section
            // failure, and is allowed to propagate.
            cancellationToken.ThrowIfCancellationRequested();

            var stopwatch = Stopwatch.StartNew();
            try
            {
                await collector.CollectAsync(draft, cancellationToken).ConfigureAwait(false);

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
            SectionErrors = sectionErrors,
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

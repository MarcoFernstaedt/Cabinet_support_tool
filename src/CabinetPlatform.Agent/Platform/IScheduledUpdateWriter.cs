using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Holds what this cabinet is due to install, and when.
/// </summary>
/// <remarks>
/// <para>
/// The schedule lives in the agent's own state file rather than in the Windows
/// Update policy key, and that is a deliberate reversal of an earlier design.
/// The policy key can express "install at 02:00 every day"; it cannot express
/// "install these four updates and nothing else", which is what a rep actually
/// agreed with a clinic. A schedule the machine can widen on its own is not the
/// schedule that was approved.
/// </para>
/// <para>
/// It is stored as a UTC instant. That is what makes it correct across a
/// daylight-saving transition between scheduling and execution: a wall-clock
/// time written down in March means a different instant in April, and the
/// instant is the thing that was agreed. The cabinet-local rendering is
/// re-derived whenever anybody asks, rather than carried forward.
/// </para>
/// <para>
/// It is on disk, so a cabinet that reboots between scheduling and execution
/// still installs. A schedule held only in a running process is exactly the
/// schedule that is not there when it is needed.
/// </para>
/// </remarks>
public interface IScheduledUpdateWriter
{
    /// <summary>Records a schedule, replacing any it already held.</summary>
    /// <param name="schedule">What to install, and when.</param>
    void Schedule(ScheduledUpdateInstall schedule);

    /// <summary>Reads the schedule in force, or null when there is none.</summary>
    ScheduledUpdateInstall? Read();

    /// <summary>
    /// Withdraws the schedule.
    /// </summary>
    /// <returns>True when there was one to withdraw.</returns>
    bool Cancel();
}

/// <summary>
/// State-file-backed implementation.
/// </summary>
/// <remarks>
/// Uses the same store as the action journal and the machine identity, so a
/// schedule survives a restart by the same mechanism that already survives one,
/// and there is one file on the cabinet to reason about rather than two.
/// </remarks>
public sealed class ScheduledUpdateWriter : IScheduledUpdateWriter
{
    private readonly IAgentStateStore _stateStore;
    private readonly ILogger<ScheduledUpdateWriter> _logger;

    /// <summary>Creates the writer.</summary>
    /// <param name="stateStore">The agent's durable state.</param>
    /// <param name="logger">Diagnostic log.</param>
    public ScheduledUpdateWriter(IAgentStateStore stateStore, ILogger<ScheduledUpdateWriter> logger)
    {
        _stateStore = stateStore;
        _logger = logger;
    }

    /// <inheritdoc />
    public void Schedule(ScheduledUpdateInstall schedule)
    {
        _stateStore.Update(current => current with { ScheduledUpdate = schedule });

        _logger.LogInformation(
            "{UpdateCount} update(s) are scheduled to install at {ScheduledUtc:O}, requested by " +
            "{RequestedBy} under action {ActionRequestId}.",
            schedule.UpdateIds.Count,
            schedule.ScheduledForUtc,
            schedule.RequestedByUserId,
            schedule.ActionRequestId);
    }

    /// <inheritdoc />
    public ScheduledUpdateInstall? Read() => _stateStore.Load().ScheduledUpdate;

    /// <inheritdoc />
    public bool Cancel()
    {
        var had = false;

        _stateStore.Update(current =>
        {
            had = current.ScheduledUpdate is not null;
            return current with { ScheduledUpdate = null };
        });

        if (had)
        {
            _logger.LogInformation("The scheduled update install was cancelled.");
        }

        return had;
    }

    /// <summary>
    /// Renders a schedule for the console, with the cabinet-local time derived
    /// now rather than carried forward.
    /// </summary>
    /// <remarks>
    /// Derived at the moment of asking, on purpose. If the zone's offset has
    /// changed since the schedule was written — which is exactly what happens
    /// across a daylight-saving transition — the wall-clock time the cabinet
    /// will actually install at differs from the one written down, and the
    /// honest answer is the one derived from the stored instant now.
    /// </remarks>
    /// <param name="schedule">The schedule, or null when there is none.</param>
    /// <param name="zone">The cabinet's own time zone.</param>
    public static ScheduledUpdateInstallDto Describe(
        ScheduledUpdateInstall? schedule, TimeZoneInfo zone)
    {
        if (schedule is null)
        {
            return new ScheduledUpdateInstallDto { HasSchedule = false, RebootIfRequired = false };
        }

        return new ScheduledUpdateInstallDto
        {
            HasSchedule = true,
            ScheduledForUtc = schedule.ScheduledForUtc,
            ScheduledForCabinetLocal =
                TimeZoneInfo.ConvertTime(schedule.ScheduledForUtc, zone),
            UpdateIds = schedule.UpdateIds,
            RebootIfRequired = schedule.RebootIfRequired,
            RequestedByUserId = schedule.RequestedByUserId,
            ActionRequestId = schedule.ActionRequestId,
        };
    }
}

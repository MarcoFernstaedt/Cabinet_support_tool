using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Actions;

/// <summary>
/// A scheduled install runs when its instant arrives, survives a reboot, and
/// reports what the machine actually did.
/// </summary>
/// <remarks>
/// Scheduling an install and installing one are different facts. A fleet that
/// treats the first as the second believes it is patched the moment a request
/// is dispatched, when the machine may still reboot into a rollback, run out of
/// disk, or find the package superseded.
/// </remarks>
public class ScheduledUpdateRunnerTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 12, 10, 0, 0, TimeSpan.Zero);

    [Fact]
    public void An_install_that_is_not_yet_due_does_not_run()
    {
        var schedule = new StubScheduleWriter
        {
            Schedule = Due(Now.AddHours(4)),
        };

        var updates = new StubUpdateGateway();

        Runner(schedule, updates).RunDueInstall(CancellationToken.None);

        Assert.Empty(updates.Installed);
        Assert.NotNull(schedule.Schedule);
    }

    [Fact]
    public void An_install_whose_instant_has_arrived_runs_and_queues_its_outcome()
    {
        var schedule = new StubScheduleWriter { Schedule = Due(Now.AddMinutes(-1)) };
        var updates = new StubUpdateGateway();
        var state = new InMemoryAgentStateStore();

        Runner(schedule, updates, state).RunDueInstall(CancellationToken.None);

        Assert.Equal(new[] { "a0d9f1e4-0000-4000-8000-000000000001" }, updates.Installed);

        // Queued rather than only returned. An install cannot be undone, so the
        // record of what it did is the only thing that can be lost.
        UpdateInstallOutcome queued = Assert.Single(state.Load().PendingUpdateOutcomes);
        Assert.Equal(schedule.LastScheduledActionId, queued.ActionRequestId);
    }

    [Fact]
    public void The_schedule_is_cleared_before_the_install_runs()
    {
        // An install that restarts the machine partway would otherwise be found
        // due again on the next start and run a second time, which on a cabinet
        // is how one approved change becomes two.
        var schedule = new StubScheduleWriter { Schedule = Due(Now.AddMinutes(-1)) };

        var updates = new StubUpdateGateway
        {
            OnInstall = () => Assert.Null(schedule.Schedule),
        };

        Runner(schedule, updates).RunDueInstall(CancellationToken.None);

        Assert.NotEmpty(updates.Installed);
        Assert.Null(schedule.Schedule);
    }

    [Fact]
    public void An_install_that_throws_is_reported_as_a_failure_per_update_rather_than_dropped()
    {
        // The fleet has to learn this cabinet did not get patched. Silence
        // reads as success.
        var schedule = new StubScheduleWriter { Schedule = Due(Now.AddMinutes(-1)) };
        var updates = new StubUpdateGateway { Throw = true };
        var state = new InMemoryAgentStateStore();

        Runner(schedule, updates, state).RunDueInstall(CancellationToken.None);

        UpdateInstallOutcome queued = Assert.Single(state.Load().PendingUpdateOutcomes);
        Assert.All(queued.Results, r => Assert.Equal(UpdateResultCode.Failed, r.ResultCode));
    }

    [Fact]
    public void Outcomes_are_cleared_only_once_a_check_in_has_carried_them()
    {
        var state = new InMemoryAgentStateStore();
        var schedule = new StubScheduleWriter { Schedule = Due(Now.AddMinutes(-1)) };

        ScheduledUpdateRunner runner = Runner(schedule, new StubUpdateGateway(), state);

        runner.RunDueInstall(CancellationToken.None);

        IReadOnlyList<UpdateInstallOutcome> pending = runner.PendingOutcomes;
        Assert.Single(pending);

        // An outcome for an action nobody reported stays queued: losing it to a
        // network outage would leave the fleet believing this cabinet is
        // patched when it is not.
        runner.ClearReportedOutcomes(Array.Empty<UpdateInstallOutcome>());
        Assert.Single(runner.PendingOutcomes);

        runner.ClearReportedOutcomes(pending);
        Assert.Empty(runner.PendingOutcomes);
    }

    /// <summary>
    /// The comparison is between two UTC instants, so a daylight-saving
    /// transition between scheduling and execution cannot move the install.
    /// </summary>
    /// <remarks>
    /// A wall-clock time written down in March means a different instant in
    /// April. Storing the instant is what makes the schedule survive that; this
    /// pins that nothing along the way re-derives a local time and compares
    /// against it instead.
    /// </remarks>
    [Fact]
    public void A_daylight_saving_transition_does_not_move_the_stored_instant()
    {
        // 02:30 on 29 March 2026 in London is 01:30 UTC, because the clocks go
        // forward at 01:00 UTC that morning. An install scheduled from a
        // February conversation for that instant runs at that instant.
        var scheduledUtc = new DateTimeOffset(2026, 3, 29, 1, 30, 0, TimeSpan.Zero);

        var schedule = new StubScheduleWriter { Schedule = Due(scheduledUtc) };
        var updates = new StubUpdateGateway();
        var clock = new FixedClock(scheduledUtc.AddSeconds(-1));

        Runner(schedule, updates, clock: clock).RunDueInstall(CancellationToken.None);
        Assert.Empty(updates.Installed);

        clock.Advance(TimeSpan.FromSeconds(2));

        Runner(schedule, updates, clock: clock).RunDueInstall(CancellationToken.None);
        Assert.NotEmpty(updates.Installed);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("Demo")]
    public void Restricted_mode_preserves_old_due_schedule_without_installing(string? mode)
    {
        var schedule = new StubScheduleWriter { Schedule = Due(Now.AddDays(-1)) };
        var updates = new StubUpdateGateway();
        var runner = new ScheduledUpdateRunner(schedule, updates, new StubRollbackStore(),
            new StubNetworkGateway(current: null), new InMemoryAgentStateStore(),
            new FixedClock(Now), NullLogger<ScheduledUpdateRunner>.Instance,
            mode is null ? null : TestOptions.Create(new CabinetPlatform.Agent.Configuration.AgentOptions
            { Actions = new() { ExecutionMode = mode } }));
        runner.RunDueInstall(CancellationToken.None);
        Assert.Empty(updates.Installed);
        Assert.NotNull(schedule.Schedule);
    }

    private static ScheduledUpdateInstall Due(DateTimeOffset at) => new()
    {
        ActionRequestId = Guid.Parse("11111111-2222-4333-8444-555555555555"),
        RequestedByUserId = Guid.NewGuid(),
        ScheduledForUtc = at,
        UpdateIds = new[] { "a0d9f1e4-0000-4000-8000-000000000001" },
        RebootIfRequired = true,
    };

    private static ScheduledUpdateRunner Runner(
        IScheduledUpdateWriter schedule,
        IWindowsUpdateGateway updates,
        IAgentStateStore? state = null,
        FixedClock? clock = null) =>
        new(
            schedule,
            updates,
            new StubRollbackStore(),
            new StubNetworkGateway(current: null),
            state ?? new InMemoryAgentStateStore(),
            clock ?? new FixedClock(Now),
            NullLogger<ScheduledUpdateRunner>.Instance,
            TestOptions.Create(new CabinetPlatform.Agent.Configuration.AgentOptions
            { Actions = new() { ExecutionMode = "Maintenance" } }));
}

/// <summary>A schedule held in memory.</summary>
internal sealed class StubScheduleWriter : IScheduledUpdateWriter
{
    public ScheduledUpdateInstall? Schedule { get; set; }

    /// <summary>The action id of whatever was last scheduled, kept after a cancel.</summary>
    public Guid LastScheduledActionId { get; private set; }

    void IScheduledUpdateWriter.Schedule(ScheduledUpdateInstall schedule)
    {
        Schedule = schedule;
        LastScheduledActionId = schedule.ActionRequestId;
    }

    public ScheduledUpdateInstall? Read()
    {
        if (Schedule is { } schedule)
        {
            LastScheduledActionId = schedule.ActionRequestId;
        }

        return Schedule;
    }

    public bool Cancel()
    {
        bool had = Schedule is not null;
        Schedule = null;
        return had;
    }
}

/// <summary>A Windows Update Agent a test controls.</summary>
internal sealed class StubUpdateGateway : IWindowsUpdateGateway
{
    /// <summary>Update ids this stub was asked to install.</summary>
    public List<string> Installed { get; } = new();

    /// <summary>Runs at the moment an install starts, for ordering assertions.</summary>
    public Action? OnInstall { get; set; }

    /// <summary>When set, installing throws.</summary>
    public bool Throw { get; set; }

    public IReadOnlyList<PendingUpdateInfo> SearchPendingUpdates(
        bool online, CancellationToken cancellationToken) => Array.Empty<PendingUpdateInfo>();

    public IReadOnlyList<UpdateHistoryEntry> GetHistory(
        int maximumEntries, CancellationToken cancellationToken) => Array.Empty<UpdateHistoryEntry>();

    public UpdateInstallOutcome InstallUpdates(
        IReadOnlyList<string> updateIds, CancellationToken cancellationToken)
    {
        OnInstall?.Invoke();

        if (Throw)
        {
            throw new InvalidOperationException("The Windows Update Agent refused the install.");
        }

        Installed.AddRange(updateIds);

        return new UpdateInstallOutcome
        {
            ActionRequestId = Guid.Empty,
            CompletedUtc = DateTimeOffset.UtcNow,
            RebootRequired = false,
            Results = updateIds
                .Select(id => new UpdateInstallResult
                {
                    UpdateId = id,
                    ResultCode = UpdateResultCode.Succeeded,
                })
                .ToList(),
        };
    }
}

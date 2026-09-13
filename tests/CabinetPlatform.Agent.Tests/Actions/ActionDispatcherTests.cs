using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Actions;

public class ActionDispatcherTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 10, 18, 0, 0, TimeSpan.Zero);
    private static readonly Guid CabinetId = Guid.Parse("11111111-1111-1111-1111-111111111111");

    [Fact]
    public async Task DispatchAsync_RunsTheExecutorRegisteredForTheAction()
    {
        var executor = new RecordingExecutor(ActionName.FlushDnsCache);
        var dispatcher = Dispatcher(ApprovedState(), executor);

        var result = await dispatcher.DispatchAsync(Request(ActionName.FlushDnsCache), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, result.Status);
        Assert.Equal(1, executor.CallCount);
        Assert.Equal(Now, result.CompletedAtUtc);
    }

    [Fact]
    public async Task DispatchAsync_DeniesAnActionWithNoRegisteredExecutor()
    {
        // The central rule: the catalog is what the agent has compiled-in
        // executors for. There is no interpretation path and no default branch.
        var dispatcher = Dispatcher(ApprovedState(), new RecordingExecutor(ActionName.FlushDnsCache));

        var result = await dispatcher.DispatchAsync(Request(ActionName.RebootMachine), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Contains("no executor", result.Output!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task DispatchAsync_DeniesEveryActionWhenNoExecutorsAreRegisteredAtAll()
    {
        var dispatcher = Dispatcher(ApprovedState());

        foreach (var action in Enum.GetValues<ActionName>())
        {
            var result = await dispatcher.DispatchAsync(Request(action), CancellationToken.None);

            Assert.Equal(ActionStatus.Denied, result.Status);
        }
    }

    [Fact]
    public async Task DispatchAsync_DeniesAnActionNameOutsideTheCatalog()
    {
        // A value outside the enum can only arrive from a default-initialised
        // or corrupted field, never from a valid request.
        var dispatcher = Dispatcher(ApprovedState(), new RecordingExecutor(ActionName.FlushDnsCache));
        var request = Request(ActionName.FlushDnsCache) with { Action = (ActionName)9999 };

        var result = await dispatcher.DispatchAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
    }

    [Fact]
    public async Task DispatchAsync_DeniesActionsUntilTheCabinetIsApproved()
    {
        var executor = new RecordingExecutor(ActionName.FlushDnsCache);
        var dispatcher = Dispatcher(new AgentState { MachineId = "m" }, executor);

        var result = await dispatcher.DispatchAsync(Request(ActionName.FlushDnsCache), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Equal(0, executor.CallCount);
    }

    [Fact]
    public async Task DispatchAsync_DeniesAnActionAddressedToADifferentCabinet()
    {
        var executor = new RecordingExecutor(ActionName.FlushDnsCache);
        var dispatcher = Dispatcher(ApprovedState(), executor);

        var request = Request(ActionName.FlushDnsCache) with { CabinetId = Guid.NewGuid() };
        var result = await dispatcher.DispatchAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Equal(0, executor.CallCount);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task DispatchAsync_DeniesAnActionWithNoStatedReason(string reason)
    {
        // Every action on a DEA-regulated cabinet must be justifiable after the
        // fact. One that arrives without a reason cannot be.
        var dispatcher = Dispatcher(ApprovedState(), new RecordingExecutor(ActionName.FlushDnsCache));

        var request = Request(ActionName.FlushDnsCache) with { Reason = reason };
        var result = await dispatcher.DispatchAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
    }

    [Fact]
    public async Task DispatchAsync_DeniesAnActionWithNoNamedRequester()
    {
        var dispatcher = Dispatcher(ApprovedState(), new RecordingExecutor(ActionName.FlushDnsCache));

        // Guid.Empty is what an unset requester deserialises to. An action on a
        // DEA-regulated machine that cannot say who asked for it cannot be
        // justified after the fact, which is reason enough to refuse it.
        var request = Request(ActionName.FlushDnsCache) with { RequestedByUserId = Guid.Empty };
        var result = await dispatcher.DispatchAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
    }

    [Fact]
    public async Task DispatchAsync_ReportsATimeoutRatherThanAFailure()
    {
        // A timed-out action may still be running on the cabinet. Reporting it
        // as failed would assert something the agent does not know.
        var options = new AgentOptions();
        options.Actions.DefaultTimeoutSeconds = 1;

        var executor = new SlowExecutor(ActionName.ScanForUpdates, TimeSpan.FromSeconds(30));
        var dispatcher = Dispatcher(ApprovedState(), options, executor);

        var result = await dispatcher.DispatchAsync(Request(ActionName.ScanForUpdates), CancellationToken.None);

        Assert.Equal(ActionStatus.TimedOut, result.Status);
        Assert.Contains("may still be in progress", result.Output!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task DispatchAsync_UsesThePerActionTimeoutWhenOneIsConfigured()
    {
        var options = new AgentOptions();
        options.Actions.DefaultTimeoutSeconds = 3600;
        options.Actions.TimeoutSecondsByAction[nameof(ActionName.ScanForUpdates)] = 1;

        var executor = new SlowExecutor(ActionName.ScanForUpdates, TimeSpan.FromSeconds(30));
        var dispatcher = Dispatcher(ApprovedState(), options, executor);

        var result = await dispatcher.DispatchAsync(Request(ActionName.ScanForUpdates), CancellationToken.None);

        Assert.Equal(ActionStatus.TimedOut, result.Status);
    }

    [Fact]
    public async Task DispatchAsync_ReportsAThrowingExecutorAsFailed()
    {
        var executor = new ThrowingExecutor(ActionName.FlushDnsCache, new InvalidOperationException("dnsapi said no"));
        var dispatcher = Dispatcher(ApprovedState(), executor);

        var result = await dispatcher.DispatchAsync(Request(ActionName.FlushDnsCache), CancellationToken.None);

        Assert.Equal(ActionStatus.Failed, result.Status);
        Assert.Contains("dnsapi said no", result.Output!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DispatchAsync_JournalsTheActionWhileItRunsAndClearsItAfterwards()
    {
        var stateStore = new InMemoryAgentStateStore(ApprovedState());
        AgentState? stateDuringExecution = null;

        var executor = new RecordingExecutor(ActionName.RebootMachine)
        {
            OnExecute = () => stateDuringExecution = stateStore.Load(),
        };

        var dispatcher = Dispatcher(stateStore, new AgentOptions(), executor);
        var request = Request(ActionName.RebootMachine);

        await dispatcher.DispatchAsync(request, CancellationToken.None);

        // Journalled before it runs, so a machine that never comes back from a
        // reboot still leaves a record that something was in progress.
        Assert.NotNull(stateDuringExecution?.InFlightAction);
        Assert.Equal(request.Id, stateDuringExecution!.InFlightAction!.RequestId);
        Assert.Equal(ActionName.RebootMachine, stateDuringExecution.InFlightAction.Action);

        Assert.Null(stateStore.Load().InFlightAction);
    }

    [Fact]
    public async Task DispatchAsync_ClearsTheJournalEvenWhenTheExecutorThrows()
    {
        var stateStore = new InMemoryAgentStateStore(ApprovedState());
        var executor = new ThrowingExecutor(ActionName.StopService, new InvalidOperationException("boom"));
        var dispatcher = Dispatcher(stateStore, new AgentOptions(), executor);

        await dispatcher.DispatchAsync(Request(ActionName.StopService), CancellationToken.None);

        // The result is known, so this is no longer an unknown outcome.
        Assert.Null(stateStore.Load().InFlightAction);
    }

    [Fact]
    public void TakeInterruptedActionResult_ReportsUnknownAndNeverResumes()
    {
        // The rule that matters most after a restart: the agent cannot know
        // whether the reboot completed or the machine lost power first, so it
        // says so and leaves the decision to a person.
        var requestId = Guid.NewGuid();
        var stateStore = new InMemoryAgentStateStore(ApprovedState() with
        {
            InFlightAction = new InFlightAction
            {
                RequestId = requestId,
                Action = ActionName.RebootMachine,
                StartedUtc = Now.AddMinutes(-5),
            },
        });

        var executor = new RecordingExecutor(ActionName.RebootMachine);
        var dispatcher = Dispatcher(stateStore, new AgentOptions(), executor);

        var result = dispatcher.TakeInterruptedActionResult();

        Assert.NotNull(result);
        Assert.Equal(requestId, result!.RequestId);
        Assert.Equal(ActionStatus.UnknownResult, result.Status);
        Assert.Contains("not resumed", result.Output!, StringComparison.OrdinalIgnoreCase);

        // Nothing was re-run.
        Assert.Equal(0, executor.CallCount);

        // And the journal is cleared, so it is reported exactly once.
        Assert.Null(stateStore.Load().InFlightAction);
        Assert.Null(dispatcher.TakeInterruptedActionResult());
    }

    [Fact]
    public void TakeInterruptedActionResult_ReturnsNothingWhenNoActionWasInFlight()
    {
        var dispatcher = Dispatcher(ApprovedState());

        Assert.Null(dispatcher.TakeInterruptedActionResult());
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task PersistenceFailureStopsExecutionOrRetainsInFlight(int failedWrite)
    {
        var store = new FailingStore(ApprovedState(), failedWrite);
        var executor = new RecordingExecutor(ActionName.RebootMachine);
        var dispatcher = Dispatcher(store, new AgentOptions(), executor);
        var request = Request(ActionName.RebootMachine);
        await Assert.ThrowsAsync<IOException>(() => dispatcher.DispatchAsync(request, CancellationToken.None));
        Assert.Equal(failedWrite == 1 ? 0 : 1, executor.CallCount);
        if (failedWrite == 2) Assert.Equal(request.Id, store.Load().InFlightAction?.RequestId);
    }

    [Fact]
    public async Task InterruptedRequestSurvivesTwoRestartsAndRedelivery()
    {
        var request = Request(ActionName.RebootMachine);
        var store = new InMemoryAgentStateStore(ApprovedState() with
        {
            InFlightAction = new InFlightAction { RequestId = request.Id, Action = request.Action, StartedUtc = Now },
        });
        var executor = new RecordingExecutor(request.Action);
        var first = Dispatcher(store, new AgentOptions(), executor).TakeInterruptedActionResult();
        var restarted = Dispatcher(store, new AgentOptions(), executor);
        restarted.TakeInterruptedActionResult();
        var replay = await restarted.DispatchAsync(request, CancellationToken.None);
        Assert.Equal(ActionStatus.UnknownResult, replay.Status);
        Assert.Equal(first, replay);
        Assert.Equal(0, executor.CallCount);
    }

    [Fact]
    public async Task StructuredResultSurvivesRestartReplay()
    {
        var request = Request(ActionName.FlushDnsCache);
        var store = new InMemoryAgentStateStore(ApprovedState());
        var executor = new RecordingExecutor(request.Action) { Data = "{\"synthetic\":true}" };
        var original = await Dispatcher(store, new AgentOptions(), executor).DispatchAsync(request, CancellationToken.None);
        var replay = await Dispatcher(store, new AgentOptions(), executor).DispatchAsync(request, CancellationToken.None);
        Assert.Equal(original.CollectedData, replay.CollectedData);
        Assert.Equal(1, executor.CallCount);
    }

    private sealed class FailingStore(AgentState state, int failedWrite) : IAgentStateStore
    {
        private AgentState _state = state;
        private int _writes;
        public AgentState Load() => _state;
        public AgentState Update(Func<AgentState, AgentState> mutate)
        {
            if (++_writes == failedWrite) throw new IOException("injected disk failure");
            return _state = mutate(_state);
        }
    }

    private static AgentState ApprovedState() => new()
    {
        MachineId = "machine-hash",
        CabinetId = CabinetId,
        RegistrationStatus = RegistrationStatus.Approved,
    };

    private static ActionRequestDto Request(ActionName action) => new()
    {
        Id = Guid.NewGuid(),
        Action = action,
        CabinetId = CabinetId,
        Reason = "Investigating a reported name resolution fault.",
        RequestedByUserId = Guid.NewGuid(),
        RequestedUtc = Now,
    };

    private static ActionDispatcher Dispatcher(AgentState state, params IActionExecutor[] executors)
        => Dispatcher(new InMemoryAgentStateStore(state), new AgentOptions(), executors);

    private static ActionDispatcher Dispatcher(
        AgentState state,
        AgentOptions options,
        params IActionExecutor[] executors)
        => Dispatcher(new InMemoryAgentStateStore(state), options, executors);

    private static ActionDispatcher Dispatcher(
        IAgentStateStore stateStore,
        AgentOptions options,
        params IActionExecutor[] executors)
        => new(
            new ActionExecutorRegistry(executors, NullLogger<ActionExecutorRegistry>.Instance),
            stateStore,
            new FixedClock(Now),
            TestOptions.Create(options),
            NullLogger<ActionDispatcher>.Instance);

    private sealed class RecordingExecutor : IActionExecutor
    {
        public RecordingExecutor(ActionName action) => Action = action;

        public ActionName Action { get; }

        public int CallCount { get; private set; }

        public Action? OnExecute { get; set; }
        public string? Data { get; set; }

        public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
        {
            CallCount++;
            OnExecute?.Invoke();
            return Task.FromResult(ActionOutcome.Succeeded("done") with { CollectedData = Data });
        }
    }

    private sealed class SlowExecutor : IActionExecutor
    {
        private readonly TimeSpan _duration;

        public SlowExecutor(ActionName action, TimeSpan duration)
        {
            Action = action;
            _duration = duration;
        }

        public ActionName Action { get; }

        public async Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
        {
            await Task.Delay(_duration, cancellationToken);
            return ActionOutcome.Succeeded();
        }
    }

    private sealed class ThrowingExecutor : IActionExecutor
    {
        private readonly Exception _failure;

        public ThrowingExecutor(ActionName action, Exception failure)
        {
            Action = action;
            _failure = failure;
        }

        public ActionName Action { get; }

        public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
            => throw _failure;
    }
}

public class ActionExecutorRegistryTests
{
    [Fact]
    public void Resolve_ReturnsNullForAnActionWithNoExecutor()
    {
        var registry = new ActionExecutorRegistry(
            Array.Empty<IActionExecutor>(),
            NullLogger<ActionExecutorRegistry>.Instance);

        Assert.Null(registry.Resolve(ActionName.RebootMachine));
        Assert.Empty(registry.ImplementedActions);
    }

    [Fact]
    public void Constructor_RejectsTwoExecutorsClaimingOneAction()
    {
        // Which executor runs would otherwise depend on DI registration order,
        // which is not something to discover on a dispensing cabinet.
        var executors = new IActionExecutor[]
        {
            new StubExecutor(ActionName.RestartService),
            new StubExecutor(ActionName.RestartService),
        };

        var exception = Assert.Throws<InvalidOperationException>(
            () => new ActionExecutorRegistry(executors, NullLogger<ActionExecutorRegistry>.Instance));

        Assert.Contains("RestartService", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Resolve_FindsEachRegisteredExecutorByItsOwnDeclaredAction()
    {
        var executors = Enum.GetValues<ActionName>()
            .Select(action => (IActionExecutor)new StubExecutor(action))
            .ToArray();

        var registry = new ActionExecutorRegistry(executors, NullLogger<ActionExecutorRegistry>.Instance);

        foreach (var action in Enum.GetValues<ActionName>())
        {
            Assert.Equal(action, registry.Resolve(action)!.Action);
        }
    }

    private sealed class StubExecutor : IActionExecutor
    {
        public StubExecutor(ActionName action) => Action = action;

        public ActionName Action { get; }

        public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
            => Task.FromResult(ActionOutcome.Succeeded());
    }
}

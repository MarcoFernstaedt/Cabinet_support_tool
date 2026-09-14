using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Tests.Actions;

public class SelectedProcessGatewayTests
{
    internal static ProcessSelectionIdentity Selection => new()
    {
        ProcessId = 900,
        ProcessName = "LabApp",
        CreationTimeFileTime = 133700000000000000,
        ExecutablePath = @"C:\Lab\LabApp.exe",
    };

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(31)]
    [InlineData(double.MaxValue)]
    public void Invalid_wait_bounds_are_refused_before_opening_a_process(double seconds)
    {
        var factory = new FakeFactory();
        var gateway = new ProcessControlGateway(factory);
        var timeout = seconds == double.MaxValue ? TimeSpan.MaxValue : TimeSpan.FromSeconds(seconds);

        Assert.Throws<ArgumentOutOfRangeException>(() => gateway.KillSelected(Selection, timeout, CancellationToken.None));
        Assert.Equal(0, factory.OpenCount);
        Assert.False(factory.Handle.Terminated);
    }

    [Theory]
    [InlineData("zero-pid")]
    [InlineData("system-pid")]
    [InlineData("self-pid")]
    [InlineData("missing-name")]
    [InlineData("missing-path")]
    [InlineData("relative-path")]
    [InlineData("long-path")]
    [InlineData("zero-creation")]
    public void An_incomplete_or_protected_identity_is_refused_without_opening(string defect)
    {
        ProcessSelectionIdentity expected = defect switch
        {
            "zero-pid" => Selection with { ProcessId = 0 },
            "system-pid" => Selection with { ProcessId = 4 },
            "self-pid" => Selection with { ProcessId = Environment.ProcessId },
            "missing-name" => Selection with { ProcessName = "" },
            "missing-path" => Selection with { ExecutablePath = "" },
            "relative-path" => Selection with { ExecutablePath = "LabApp.exe" },
            "long-path" => Selection with { ExecutablePath = @"C:\" + new string('x', 32765) },
            _ => Selection with { CreationTimeFileTime = 0 },
        };
        var factory = new FakeFactory();
        factory.Handle.Identity = expected;

        Assert.Throws<ArgumentException>(() => new ProcessControlGateway(factory)
            .KillSelected(expected, TimeSpan.FromSeconds(1), CancellationToken.None));
        Assert.Equal(0, factory.OpenCount);
        Assert.False(factory.Handle.Terminated);
    }

    [Theory]
    [InlineData("pid")]
    [InlineData("creation")]
    [InlineData("path")]
    [InlineData("name")]
    public void Every_identity_component_is_checked_on_the_retained_handle(string changed)
    {
        var factory = new FakeFactory();
        factory.Handle.Identity = changed switch
        {
            "pid" => Selection with { ProcessId = 901 },
            "creation" => Selection with { CreationTimeFileTime = Selection.CreationTimeFileTime + 1 },
            "path" => Selection with { ExecutablePath = @"C:\Other\LabApp.exe" },
            _ => Selection with { ProcessName = "OtherApp" },
        };
        Assert.Throws<ProcessIdentityMismatchException>(() => new ProcessControlGateway(factory)
            .KillSelected(Selection, TimeSpan.FromSeconds(1), CancellationToken.None));
        Assert.Equal(1, factory.OpenCount);
        Assert.False(factory.Handle.Terminated);
        Assert.True(factory.Handle.Disposed);
    }

    [Fact]
    public void A_verified_process_is_terminated_and_waited_on_through_one_handle()
    {
        var factory = new FakeFactory();
        factory.Handle.Identity = Selection with { ProcessName = "LABAPP.EXE", ExecutablePath = @"c:\lab\labapp.exe" };
        Assert.True(new ProcessControlGateway(factory).KillSelected(Selection, TimeSpan.FromSeconds(1), CancellationToken.None));
        Assert.Equal(1, factory.OpenCount);
        Assert.True(factory.Handle.Terminated);
        Assert.Equal(1, factory.Handle.WaitCount);
        Assert.True(factory.Handle.Disposed);
    }

    [Fact]
    public void A_process_marked_critical_by_windows_is_not_terminated()
    {
        var factory = new FakeFactory();
        factory.Handle.IsCritical = true;
        Assert.Throws<InvalidOperationException>(() => new ProcessControlGateway(factory)
            .KillSelected(Selection, TimeSpan.FromSeconds(1), CancellationToken.None));
        Assert.False(factory.Handle.Terminated);
        Assert.True(factory.Handle.Disposed);
    }

    [Fact]
    public void Unknown_critical_status_fails_closed()
    {
        var factory = new FakeFactory();
        factory.Handle.CriticalReadFailure = new System.ComponentModel.Win32Exception(5);
        Assert.Throws<System.ComponentModel.Win32Exception>(() => new ProcessControlGateway(factory)
            .KillSelected(Selection, TimeSpan.FromSeconds(1), CancellationToken.None));
        Assert.False(factory.Handle.Terminated);
        Assert.True(factory.Handle.Disposed);
    }

    [Fact]
    public void Cancellation_before_open_has_no_effect()
    {
        var factory = new FakeFactory();
        Assert.Throws<OperationCanceledException>(() => new ProcessControlGateway(factory)
            .KillSelected(Selection, TimeSpan.FromSeconds(1), new CancellationToken(true)));
        Assert.Equal(0, factory.OpenCount);
    }

    [Fact]
    public void Cancellation_after_inspection_disposes_without_terminating()
    {
        using var cancellation = new CancellationTokenSource();
        var factory = new FakeFactory();
        factory.Handle.OnIdentityRead = cancellation.Cancel;
        Assert.Throws<OperationCanceledException>(() => new ProcessControlGateway(factory)
            .KillSelected(Selection, TimeSpan.FromSeconds(1), cancellation.Token));
        Assert.False(factory.Handle.Terminated);
        Assert.True(factory.Handle.Disposed);
    }

    [Fact]
    public void A_wait_timeout_is_not_an_exit_confirmation()
    {
        var factory = new FakeFactory();
        factory.Handle.Exits = false;
        Assert.False(new ProcessControlGateway(factory).KillSelected(Selection, TimeSpan.FromSeconds(1), CancellationToken.None));
        Assert.True(factory.Handle.Terminated);
        Assert.True(factory.Handle.Disposed);
    }

    [Fact]
    public void Wait_error_after_termination_reports_an_ambiguous_effect()
    {
        var factory = new FakeFactory();
        factory.Handle.WaitFailure = new System.ComponentModel.Win32Exception(6);
        Exception error = Assert.ThrowsAny<Exception>(() => new ProcessControlGateway(factory)
            .KillSelected(Selection, TimeSpan.FromSeconds(1), CancellationToken.None));
        Assert.Contains("exit was not confirmed", error.Message);
        Assert.True(factory.Handle.Terminated);
        Assert.True(factory.Handle.Disposed);
    }

    [Fact]
    public void Access_denied_while_opening_does_not_terminate()
    {
        var factory = new FakeFactory { OpenFailure = new System.ComponentModel.Win32Exception(5) };
        Assert.Throws<System.ComponentModel.Win32Exception>(() => new ProcessControlGateway(factory)
            .KillSelected(Selection, TimeSpan.FromSeconds(1), CancellationToken.None));
        Assert.False(factory.Handle.Terminated);
    }

    [Theory]
    [InlineData("matched", ActionStatus.Succeeded)]
    [InlineData("same-name-replacement", ActionStatus.Denied)]
    [InlineData("different-executable", ActionStatus.Denied)]
    [InlineData("critical", ActionStatus.Failed)]
    [InlineData("access-denied", ActionStatus.Failed)]
    [InlineData("timeout", ActionStatus.Failed)]
    public async Task Executor_to_gateway_results_are_honest(string scenario, ActionStatus status)
    {
        var factory = new FakeFactory();
        if (scenario == "same-name-replacement") factory.Handle.Identity = Selection with { CreationTimeFileTime = Selection.CreationTimeFileTime + 1 };
        if (scenario == "different-executable") factory.Handle.Identity = Selection with { ExecutablePath = @"C:\Other\LabApp.exe" };
        if (scenario == "critical") factory.Handle.IsCritical = true;
        if (scenario == "access-denied") factory.OpenFailure = new System.ComponentModel.Win32Exception(5);
        if (scenario == "timeout") factory.Handle.Exits = false;
        var executor = new CabinetPlatform.Agent.Actions.Executors.KillProcessExecutor(
            new ProcessControlGateway(factory), ProcessTargetPolicyTests.Policy(new[] { "LabApp" }),
            CabinetPlatform.Agent.Tests.TestSupport.TestOptions.Create(new CabinetPlatform.Agent.Configuration.AgentOptions()),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<CabinetPlatform.Agent.Actions.Executors.KillProcessExecutor>.Instance);
        var request = new ActionRequestDto
        {
            Id = Guid.NewGuid(), CabinetId = Guid.NewGuid(), RequestedByUserId = Guid.NewGuid(),
            RequestedUtc = DateTimeOffset.UtcNow, Reason = "Stop the approved inert lab process.", Action = ActionName.KillProcess,
            Parameters = new Dictionary<string, string>
            {
                [ActionParameterKeys.ProcessId] = Selection.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                [ActionParameterKeys.ExpectedProcessName] = Selection.ProcessName,
                [ActionParameterKeys.ExpectedCreationTimeFileTime] = Selection.CreationTimeFileTime.ToString(System.Globalization.CultureInfo.InvariantCulture),
                [ActionParameterKeys.ExpectedExecutablePath] = Selection.ExecutablePath,
            },
        };
        var outcome = await executor.ExecuteAsync(request, CancellationToken.None);
        Assert.Equal(status, outcome.Status);
        Assert.Equal(scenario is "matched" or "timeout", factory.Handle.Terminated);
        Assert.Equal(1, factory.OpenCount);
        if (outcome.CollectedData is not null)
        {
            var result = System.Text.Json.JsonSerializer.Deserialize<CabinetPlatform.Contracts.Telemetry.ProcessActionResultDto>(
                outcome.CollectedData, CabinetPlatform.Agent.Transport.AgentJson.SerializerOptions)!;
            Assert.Equal(scenario == "matched" ? new[] { Selection.ProcessId } : Array.Empty<int>(), result.EndedProcessIds);
        }
    }

    internal sealed class FakeFactory : ISelectedProcessHandleFactory
    {
        public FakeHandle Handle { get; } = new();
        public int OpenCount { get; private set; }
        public Exception? OpenFailure { get; set; }
        public ISelectedProcessHandle Open(int processId)
        {
            OpenCount++;
            if (OpenFailure is not null) throw OpenFailure;
            return Handle;
        }
    }

    internal sealed class FakeHandle : ISelectedProcessHandle
    {
        private ProcessSelectionIdentity _identity = Selection;
        private bool _isCritical;
        public Action? OnIdentityRead { get; set; }
        public Exception? CriticalReadFailure { get; set; }
        public ProcessSelectionIdentity Identity
        {
            get { OnIdentityRead?.Invoke(); return _identity; }
            set => _identity = value;
        }
        public bool IsCritical
        {
            get => CriticalReadFailure is null ? _isCritical : throw CriticalReadFailure;
            set => _isCritical = value;
        }
        public bool Terminated { get; private set; }
        public bool Disposed { get; private set; }
        public bool Exits { get; set; } = true;
        public void Terminate() => Terminated = true;
        public int WaitCount { get; private set; }
        public Exception? WaitFailure { get; set; }
        public bool WaitForExit(TimeSpan timeout) { WaitCount++; if (WaitFailure is not null) throw WaitFailure; return Exits; }
        public void Dispose() => Disposed = true;
    }
}

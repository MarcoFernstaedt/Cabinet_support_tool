using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Actions;

public class RebootMachineExecutorTests
{
    [Fact]
    public async Task RefusesWhileSomebodyIsSignedIn()
    {
        // The guard that stands between a remote request and a technician
        // part-way through pulling a controlled substance.
        var native = new StubNativeSystemGateway();
        var executor = Executor(native, loggedOnUser: @"CLINIC\jrivera");

        var result = await executor.ExecuteAsync(Request(), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Contains("signed in", result.Output!, StringComparison.OrdinalIgnoreCase);
        Assert.False(native.RestartInitiated);
    }

    [Fact]
    public async Task RestartsWhenNobodyIsSignedIn()
    {
        var native = new StubNativeSystemGateway();
        var executor = Executor(native);

        var result = await executor.ExecuteAsync(Request(), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, result.Status);
        Assert.True(native.RestartInitiated);
        Assert.Equal(TimeSpan.FromSeconds(60), native.Delay);
    }

    /// <summary>
    /// The agent refuses to restart an occupied cabinet, and there is no
    /// parameter that changes its mind.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A Supervisor's waiver is a server-side decision, recorded on the request
    /// with the reason they gave. It deliberately does not travel to the agent
    /// as a parameter: a flag that waives a safety check, carried in the same
    /// channel as the request itself, is a safety check the caller can simply
    /// assert their way past.
    /// </para>
    /// <para>
    /// The two checks answer different questions anyway. The server's uses the
    /// last check-in, which can be minutes old. The agent's asks the machine
    /// who is signed in right now, and that is the one that matters to somebody
    /// standing at the cabinet.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task RefusesToRestartAnOccupiedCabinetWhateverTheRequestSays()
    {
        var native = new StubNativeSystemGateway();
        var executor = Executor(native, loggedOnUser: @"CLINIC\jrivera");

        var result = await executor.ExecuteAsync(Request(), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.False(native.RestartInitiated);
        Assert.Contains("signed in", result.Output!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RejectsAnOverrideFlagRatherThanHonouringIt()
    {
        // There is no such parameter, so this is the unknown-parameter path:
        // the agent and the server disagree about what was asked for, and on a
        // controlled-substance cabinet the safe reading of that disagreement is
        // to do nothing.
        var native = new StubNativeSystemGateway();
        var executor = Executor(native, loggedOnUser: @"CLINIC\jrivera");

        var request = Request(new Dictionary<string, string>
        {
            ["supervisorOverride"] = "true",
        });

        var result = await executor.ExecuteAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.False(native.RestartInitiated);
        Assert.Contains("does not define", result.Output!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task HonoursALongerWarningThanItsDefaultButNeverAShorterOne()
    {
        // The floor is the agent's. A request cannot shorten the notice the
        // people at the cabinet get, however it is spelled.
        var native = new StubNativeSystemGateway();

        var longer = await Executor(native).ExecuteAsync(
            Request(new Dictionary<string, string>
            {
                [ActionParameterKeys.DelaySeconds] = "300",
            }),
            CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, longer.Status);
        Assert.Equal(TimeSpan.FromSeconds(300), native.Delay);

        var shorter = new StubNativeSystemGateway();

        var result = await Executor(shorter).ExecuteAsync(
            Request(new Dictionary<string, string>
            {
                [ActionParameterKeys.DelaySeconds] = "0",
            }),
            CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, result.Status);
        Assert.Equal(TimeSpan.FromSeconds(60), shorter.Delay);
    }

    [Fact]
    public async Task RefusesWhenItCannotTellWhetherAnybodyIsSignedIn()
    {
        // An unnecessary refusal costs a support call. The alternative costs an
        // interrupted dispense, so the unknown case refuses.
        var native = new StubNativeSystemGateway();
        var wmi = new FakeWmiRepository()
            .Throws("Win32_LogonSession", new InvalidOperationException("WMI is unavailable."));

        var executor = new RebootMachineExecutor(
            new LogonSessionReader(wmi),
            native,
            TestOptions.Create(new AgentOptions()),
            NullLogger<RebootMachineExecutor>.Instance);

        var result = await executor.ExecuteAsync(Request(), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.False(native.RestartInitiated);
    }

    [Fact]
    public async Task DeniesARequestCarryingAnUndefinedParameter()
    {
        var native = new StubNativeSystemGateway();
        var executor = Executor(native);

        var request = Request(new Dictionary<string, string> { ["Force"] = "true" });
        var result = await executor.ExecuteAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.False(native.RestartInitiated);
    }

    [Fact]
    public async Task ReportsAFailedRestartAsFailedRatherThanSucceeded()
    {
        var native = new StubNativeSystemGateway
        {
            Failure = new InvalidOperationException("SeShutdownPrivilege was not granted."),
        };

        var result = await Executor(native).ExecuteAsync(Request(), CancellationToken.None);

        Assert.Equal(ActionStatus.Failed, result.Status);
    }

    private static RebootMachineExecutor Executor(INativeSystemGateway native, string? loggedOnUser = null)
    {
        var wmi = new FakeWmiRepository();

        if (loggedOnUser is not null)
        {
            wmi.Returns("Win32_LogonSession", FakeWmiRepository.Row(("LogonId", "4001"), ("LogonType", 2)))
               .Returns(
                   "Win32_LoggedOnUser",
                   FakeWmiRepository.Row(
                       ("Antecedent", $@"\\CAB\root\cimv2:Win32_Account.Domain=""CLINIC"",Name=""{loggedOnUser.Split('\\')[^1]}"""),
                       ("Dependent", @"\\CAB\root\cimv2:Win32_LogonSession.LogonId=""4001""")));
        }

        return new RebootMachineExecutor(
            new LogonSessionReader(wmi),
            native,
            TestOptions.Create(new AgentOptions()),
            NullLogger<RebootMachineExecutor>.Instance);
    }

    private static ActionRequestDto Request(IReadOnlyDictionary<string, string>? parameters = null) => new()
    {
        Id = Guid.NewGuid(),
        Action = ActionName.RebootMachine,
        CabinetId = Guid.NewGuid(),
        Reason = "Applying pending updates outside clinic hours.",
        RequestedByUserId = Guid.NewGuid(),
        RequestedUtc = DateTimeOffset.UtcNow,
        Parameters = parameters ?? new Dictionary<string, string>(),
    };

    private sealed class StubNativeSystemGateway : INativeSystemGateway
    {
        public bool RestartInitiated { get; private set; }

        public TimeSpan Delay { get; private set; }

        public bool DnsFlushed { get; private set; }

        public Exception? Failure { get; set; }

        public void FlushDnsResolverCache()
        {
            if (Failure is not null)
            {
                throw Failure;
            }

            DnsFlushed = true;
        }

        public void InitiateRestart(TimeSpan delay, string message)
        {
            if (Failure is not null)
            {
                throw Failure;
            }

            RestartInitiated = true;
            Delay = delay;
        }
    }
}

public class ServiceAllowListTests
{
    [Fact]
    public void RejectsAServiceOutsideTheList()
    {
        var allowList = AllowList("Spooler", "Dnscache");

        Assert.False(allowList.IsAllowed("CubexDispensingService", out var reason));
        Assert.Contains("not in this agent's allow-list", reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AcceptsAListedServiceRegardlessOfCase()
    {
        var allowList = AllowList("Spooler");

        Assert.True(allowList.IsAllowed("spooler", out _));
        Assert.True(allowList.IsAllowed("SPOOLER", out _));
        Assert.True(allowList.IsAllowed("  Spooler  ", out _));
    }

    [Theory]
    [InlineData(@"Spooler & shutdown /r")]
    [InlineData(@"..\..\Windows\System32\svchost.exe")]
    [InlineData("Spooler\"; DROP")]
    [InlineData("Spooler\r\nDnscache")]
    [InlineData("Spooler|calc")]
    [InlineData("")]
    public void RejectsANameThatIsNotAValidServiceName(string candidate)
    {
        // Rejected on shape before it is ever compared to the list or handed to
        // the service control manager.
        var allowList = AllowList("Spooler");

        Assert.False(allowList.IsAllowed(candidate, out _));
    }

    [Fact]
    public void AnEmptyAllowListDeniesEverything()
    {
        // A misconfigured agent that silently permitted every service would be
        // far worse than one that refuses until somebody configures it.
        var allowList = AllowList();

        Assert.False(allowList.IsAllowed("Spooler", out var reason));
        Assert.Contains("allow-list is empty", reason, StringComparison.OrdinalIgnoreCase);
    }

    private static ServiceNameAllowList AllowList(params string[] services)
    {
        var options = new AgentOptions();
        options.Actions.ServiceAllowList = services.ToList();
        return new ServiceNameAllowList(TestOptions.Create(options));
    }
}

public class ServiceExecutorTests
{
    [Fact]
    public async Task RestartStopsThenStartsAnAllowedService()
    {
        var services = new StubServiceControlGateway();
        var executor = new RestartServiceExecutor(
            services,
            AllowList("Spooler"),
            TestOptions.Create(new AgentOptions()),
            NullLogger<RestartServiceExecutor>.Instance);

        var result = await executor.ExecuteAsync(Request(ActionName.RestartService, "Spooler"), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, result.Status);
        Assert.Equal(new[] { "Stop:Spooler", "Start:Spooler" }, services.Calls);
    }

    [Fact]
    public async Task DeniesAServiceOutsideTheAgentsOwnAllowList()
    {
        // The server validated this too. Two independent checks fail
        // independently, which is the entire point of re-checking here.
        var services = new StubServiceControlGateway();
        var executor = new StopServiceExecutor(
            services,
            AllowList("Spooler"),
            TestOptions.Create(new AgentOptions()),
            NullLogger<StopServiceExecutor>.Instance);

        var request = Request(ActionName.StopService, "CubexDispensingService");
        var result = await executor.ExecuteAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Empty(services.Calls);
    }

    [Fact]
    public async Task DeniesARequestWithNoServiceName()
    {
        var services = new StubServiceControlGateway();
        var executor = new StartServiceExecutor(
            services,
            AllowList("Spooler"),
            TestOptions.Create(new AgentOptions()),
            NullLogger<StartServiceExecutor>.Instance);

        var request = Request(ActionName.StartService, serviceName: null);
        var result = await executor.ExecuteAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Empty(services.Calls);
    }

    [Fact]
    public async Task DeniesARequestCarryingAnUndefinedParameter()
    {
        var services = new StubServiceControlGateway();
        var executor = new StartServiceExecutor(
            services,
            AllowList("Spooler"),
            TestOptions.Create(new AgentOptions()),
            NullLogger<StartServiceExecutor>.Instance);

        var request = Request(ActionName.StartService, "Spooler") with
        {
            Parameters = new Dictionary<string, string>
            {
                [ActionParameterKeys.ServiceName] = "Spooler",
                ["Arguments"] = "--unexpected",
            },
        };

        var result = await executor.ExecuteAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Empty(services.Calls);
    }

    private static ServiceNameAllowList AllowList(params string[] services)
    {
        var options = new AgentOptions();
        options.Actions.ServiceAllowList = services.ToList();
        return new ServiceNameAllowList(TestOptions.Create(options));
    }

    private static ActionRequestDto Request(ActionName action, string? serviceName) => new()
    {
        Id = Guid.NewGuid(),
        Action = action,
        CabinetId = Guid.NewGuid(),
        Reason = "The print queue is stuck.",
        RequestedByUserId = Guid.NewGuid(),
        RequestedUtc = DateTimeOffset.UtcNow,
        Parameters = serviceName is null
            ? new Dictionary<string, string>()
            : new Dictionary<string, string> { [ActionParameterKeys.ServiceName] = serviceName },
    };

    private sealed class StubServiceControlGateway : IServiceControlGateway
    {
        public List<string> Calls { get; } = new();

        public ServiceState GetState(string serviceName) => ServiceState.Running;

        public void Start(string serviceName, TimeSpan timeout) => Calls.Add($"Start:{serviceName}");

        public void Stop(string serviceName, TimeSpan timeout) => Calls.Add($"Stop:{serviceName}");

        public ServiceStartType StartType { get; set; } = ServiceStartType.Automatic;

        public ServiceStartType GetStartType(string serviceName) => StartType;

        public void SetStartType(string serviceName, ServiceStartType startType)
        {
            Calls.Add($"SetStartType:{serviceName}:{startType}");
            StartType = startType;
        }
    }
}

public class ScanForUpdatesExecutorTests
{
    [Fact]
    public async Task AsksWindowsUpdateToActuallyLookRatherThanRereadingWhatItKnew()
    {
        // Somebody asked this cabinet to scan. Returning the last cached answer
        // would look identical in the console and mean nothing.
        var gateway = new StubGateway();

        var result = await new ScanForUpdatesExecutor(gateway, NullLogger<ScanForUpdatesExecutor>.Instance)
            .ExecuteAsync(Request(), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, result.Status);
        Assert.True(gateway.SearchedOnline);
    }

    [Fact]
    public async Task ReportsHowManyUpdatesAreSecurityUpdates()
    {
        var gateway = new StubGateway
        {
            Pending = new[]
            {
                new PendingUpdateInfo
                {
                    UpdateId = "a",
                    Title = "2026-09 Cumulative Update",
                    Classification = UpdateClassification.SecurityUpdate,
                    IsSecurity = true,
                },
                new PendingUpdateInfo
                {
                    UpdateId = "b",
                    Title = "A driver",
                    Classification = UpdateClassification.Driver,
                },
            },
        };

        var result = await new ScanForUpdatesExecutor(gateway, NullLogger<ScanForUpdatesExecutor>.Instance)
            .ExecuteAsync(Request(), CancellationToken.None);

        Assert.Contains("2 update(s)", result.Output!, StringComparison.Ordinal);
        Assert.Contains("1 of them security", result.Output!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DeniesARequestCarryingAnyParameterAtAll()
    {
        var gateway = new StubGateway();

        var request = Request() with
        {
            Parameters = new Dictionary<string, string> { ["Online"] = "false" },
        };

        var result = await new ScanForUpdatesExecutor(gateway, NullLogger<ScanForUpdatesExecutor>.Instance)
            .ExecuteAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Null(gateway.SearchedOnline);
    }

    private static ActionRequestDto Request() => new()
    {
        Id = Guid.NewGuid(),
        Action = ActionName.ScanForUpdates,
        CabinetId = Guid.NewGuid(),
        Reason = "Checking patch level before a compliance review.",
        RequestedByUserId = Guid.NewGuid(),
        RequestedUtc = DateTimeOffset.UtcNow,
    };

    private sealed class StubGateway : IWindowsUpdateGateway
    {
        public bool? SearchedOnline { get; private set; }

        public IReadOnlyList<PendingUpdateInfo> Pending { get; set; } = Array.Empty<PendingUpdateInfo>();

        public IReadOnlyList<PendingUpdateInfo> SearchPendingUpdates(bool online, CancellationToken cancellationToken)
        {
            SearchedOnline = online;
            return Pending;
        }

        public IReadOnlyList<UpdateHistoryEntry> GetHistory(int maximumEntries, CancellationToken cancellationToken)
            => Array.Empty<UpdateHistoryEntry>();

        public UpdateInstallOutcome InstallUpdates(
            IReadOnlyList<string> updateIds, CancellationToken cancellationToken) =>
            throw new NotSupportedException("This stub does not install.");
    }
}

public class ScheduleUpdatesExecutorTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 10, 18, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task SchedulesAValidFutureInstall()
    {
        var writer = new StubScheduledUpdateWriter();
        var scheduled = Now.AddDays(2);

        var result = await Executor(writer).ExecuteAsync(Request(scheduled.ToString("O")), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, result.Status);
        Assert.Equal(scheduled, writer.Scheduled);
    }

    [Fact]
    public async Task DeniesATimeInThePast()
    {
        // Windows would install at the next opportunity, which is to say
        // immediately: the opposite of scheduling.
        var writer = new StubScheduledUpdateWriter();

        var result = await Executor(writer)
            .ExecuteAsync(Request(Now.AddHours(-1).ToString("O")), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Null(writer.Scheduled);
    }

    [Fact]
    public async Task DeniesATimeFurtherOutThanTheConfiguredLimit()
    {
        // A schedule far enough out is indistinguishable from never patching,
        // which on these machines is a compliance problem.
        var writer = new StubScheduledUpdateWriter();

        var result = await Executor(writer)
            .ExecuteAsync(Request(Now.AddDays(400).ToString("O")), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Null(writer.Scheduled);
    }

    [Theory]
    [InlineData("not a timestamp")]
    [InlineData("")]
    [InlineData("Tuesday")]
    public async Task DeniesAnUnparseableTimestamp(string value)
    {
        var writer = new StubScheduledUpdateWriter();

        var result = await Executor(writer).ExecuteAsync(Request(value), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Null(writer.Scheduled);
    }

    [Fact]
    public async Task NormalisesAnOffsetTimestampToUtc()
    {
        // A cabinet two time zones from the support desk must not install at
        // what turns out to be the middle of its own working day.
        var writer = new StubScheduledUpdateWriter();

        var result = await Executor(writer)
            .ExecuteAsync(Request("2026-09-12T22:00:00-05:00"), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, result.Status);
        Assert.Equal(new DateTimeOffset(2026, 9, 13, 3, 0, 0, TimeSpan.Zero), writer.Scheduled);
    }

    private static ScheduleUpdatesExecutor Executor(IScheduledUpdateWriter writer)
        => new(
            writer,
            new FixedClock(Now),
            TestOptions.Create(new AgentOptions()),
            NullLogger<ScheduleUpdatesExecutor>.Instance);

    private static ActionRequestDto Request(string scheduledUtc) => new()
    {
        Id = Guid.NewGuid(),
        Action = ActionName.ScheduleUpdates,
        CabinetId = Guid.NewGuid(),
        Reason = "Applying the September cumulative update.",
        RequestedByUserId = Guid.NewGuid(),
        RequestedUtc = Now,
        Parameters = new Dictionary<string, string>
        {
            [ActionParameterKeys.ScheduledForUtc] = scheduledUtc,

            // Specific updates, always. "Everything applicable" would install
            // whatever had become applicable between the rep choosing and the
            // machine acting, which is not what anybody agreed to.
            [ActionParameterKeys.UpdateIds] = "a0d9f1e4-0000-4000-8000-000000000001",
        },
    };

    private sealed class StubScheduledUpdateWriter : IScheduledUpdateWriter
    {
        private ScheduledUpdateInstall? _schedule;

        public DateTimeOffset? Scheduled => _schedule?.ScheduledForUtc;

        public IReadOnlyList<string> UpdateIds => _schedule?.UpdateIds ?? Array.Empty<string>();

        public void Schedule(ScheduledUpdateInstall schedule) => _schedule = schedule;

        public ScheduledUpdateInstall? Read() => _schedule;

        public bool Cancel()
        {
            bool had = _schedule is not null;
            _schedule = null;
            return had;
        }
    }
}

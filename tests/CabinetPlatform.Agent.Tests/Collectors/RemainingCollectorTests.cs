using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Collectors;

public class ServiceCollectorTests
{
    [Fact]
    public async Task CollectAsync_ReadsStateStartTypeAccountAndPidInOneQuery()
    {
        var wmi = new FakeWmiRepository()
            .Returns(
                "Win32_Service",
                FakeWmiRepository.Row(
                    ("Name", "CubexCabinetService"),
                    ("DisplayName", "CUBEX Cabinet Service"),
                    ("State", "Running"),
                    ("StartMode", "Auto"),
                    ("StartName", @"NT AUTHORITY\LocalSystem"),
                    ("ProcessId", 4820)),
                FakeWmiRepository.Row(
                    ("Name", "StoppedThing"),
                    ("State", "Stopped"),
                    ("StartMode", "Disabled"),
                    ("ProcessId", 0)));

        var draft = new CheckInDraft();
        await new ServiceCollector(wmi).CollectAsync(draft, CheckInTier.Full, CancellationToken.None);

        Assert.Equal(2, draft.Services!.Count);

        var running = Assert.Single(draft.Services!, service => service.Name == "CubexCabinetService");
        Assert.Equal(ServiceState.Running, running.State);
        Assert.Equal(ServiceStartType.Automatic, running.StartType);
        Assert.Equal(@"NT AUTHORITY\LocalSystem", running.RunAsAccount);
        Assert.Equal(4820, running.ProcessId);

        // A stopped service reports pid 0, which is not a process id.
        var stopped = Assert.Single(draft.Services!, service => service.Name == "StoppedThing");
        Assert.Null(stopped.ProcessId);

        // One query, not one round trip per service.
        Assert.Single(wmi.ExecutedQueries);
    }

    [Fact]
    public void ParseStartType_DistinguishesDelayedAutoStartFromPlainAuto()
    {
        // WMI calls both "Auto". Collapsing them makes a delayed service that
        // has not started yet look like one that failed to start.
        Assert.Equal(ServiceStartType.Automatic, ServiceCollector.ParseStartType("Auto", delayedAutoStart: false));
        Assert.Equal(ServiceStartType.AutomaticDelayed, ServiceCollector.ParseStartType("Auto", delayedAutoStart: true));
        Assert.Equal(ServiceStartType.Automatic, ServiceCollector.ParseStartType("Auto", delayedAutoStart: null));
    }

    [Theory]
    [InlineData("Boot", ServiceStartType.Boot)]
    [InlineData("System", ServiceStartType.System)]
    [InlineData("Manual", ServiceStartType.Manual)]
    [InlineData("Disabled", ServiceStartType.Disabled)]
    [InlineData("Nonsense", ServiceStartType.Unknown)]
    [InlineData(null, ServiceStartType.Unknown)]
    public void ParseStartType_MapsTheRest(string? startMode, ServiceStartType expected)
    {
        Assert.Equal(expected, ServiceCollector.ParseStartType(startMode, delayedAutoStart: null));
    }

    [Theory]
    [InlineData("Running", ServiceState.Running)]
    [InlineData("Stopped", ServiceState.Stopped)]
    [InlineData("Start Pending", ServiceState.StartPending)]
    [InlineData("Stop Pending", ServiceState.StopPending)]
    [InlineData("Paused", ServiceState.Paused)]
    [InlineData("Something else", ServiceState.Unknown)]
    public void ParseState_MapsEveryDocumentedState(string state, ServiceState expected)
    {
        Assert.Equal(expected, ServiceCollector.ParseState(state));
    }
}

public class PerformanceCollectorTests
{
    [Fact]
    public async Task CollectAsync_ReportsMemoryAndPageFileInBytes()
    {
        var wmi = new FakeWmiRepository()
            .Returns(
                "Win32_OperatingSystem",
                // WMI reports these in kilobytes: 8 GB total, 2 GB free.
                FakeWmiRepository.Row(
                    ("TotalVisibleMemorySize", 8_388_608L),
                    ("FreePhysicalMemory", 2_097_152L)))
            .Returns(
                "Win32_PageFileUsage",
                // And these in megabytes.
                FakeWmiRepository.Row(("AllocatedBaseSize", 4096L), ("CurrentUsage", 1024L)))
            .Returns(
                "Win32_PerfFormattedData_PerfOS_Processor",
                FakeWmiRepository.Row(("Name", "0"), ("PercentProcessorTime", 12L)),
                FakeWmiRepository.Row(("Name", "1"), ("PercentProcessorTime", 30L)),
                FakeWmiRepository.Row(("Name", "_Total"), ("PercentProcessorTime", 21L)));

        var draft = await CollectAsync(wmi, new StubProcessProvider());

        var performance = draft.Performance!;
        Assert.Equal(8_589_934_592L, performance.RamTotalBytes);
        Assert.Equal(2_147_483_648L, performance.RamAvailableBytes);
        Assert.Equal(75.0, performance.RamUsedPercent);
        Assert.Equal(4_294_967_296L, performance.PageFileTotalBytes);
        Assert.Equal(1_073_741_824L, performance.PageFileUsedBytes);

        Assert.Equal(21.0, performance.CpuTotalPercent);
        Assert.Equal(new[] { 12.0, 30.0 }, performance.CpuPerCorePercent);
    }

    [Fact]
    public async Task CollectAsync_ReportsNullPageFileOnAMachineWithNone()
    {
        // Running without a page file is a legitimate configuration. Zero used
        // of zero total would read as a measurement rather than an absence.
        var wmi = new FakeWmiRepository()
            .Returns("Win32_OperatingSystem", FakeWmiRepository.Row(("TotalVisibleMemorySize", 1024L)));

        var draft = await CollectAsync(wmi, new StubProcessProvider());

        Assert.Null(draft.Performance!.PageFileTotalBytes);
        Assert.Null(draft.Performance.PageFileUsedBytes);
    }

    [Fact]
    public async Task CollectAsync_TakesTwoProcessSamplesSoCpuIsARateNotATotal()
    {
        var provider = new StubProcessProvider();
        await CollectAsync(new FakeWmiRepository(), provider);

        // One sample cannot express a rate: the first read of any cumulative
        // counter has nothing to be compared against.
        Assert.Equal(2, provider.CallCount);
    }

    /// <summary>
    /// The process list is on-demand only; the startup programs are inventory.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Two different things that were briefly gated behind one flag, which made
    /// the startup programs uncollectable: the server stored a field for them,
    /// the console displayed it, and the agent never populated it on any tier.
    /// Nothing failed — the panel was simply always empty.
    /// </para>
    /// <para>
    /// They are gated separately because they are different kinds of thing. A
    /// process list is a sample, large and constantly changing, read for one
    /// cabinet at a time by somebody already looking at it. What a machine
    /// launches at logon is configuration: it changes when somebody installs
    /// something, and it belongs with the rest of the inventory.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData(CheckInTier.Heartbeat, false)]
    [InlineData(CheckInTier.Full, true)]
    public async Task CollectAsync_CollectsStartupProgramsOnTheInventoryTierOnly(
        CheckInTier tier, bool expected)
    {
        CheckInDraft draft = await CollectAsync(new FakeWmiRepository(), new StubProcessProvider(), tier);

        Assert.Equal(expected, draft.Performance!.StartupPrograms is not null);

        // Never on either routine tier. A process list is a sample and travels
        // on an action.
        Assert.Null(draft.Performance.Processes);
    }

    [Fact]
    public async Task CollectAsync_CollectsProcessesOnlyWhenTheOnDemandActionAsks()
    {
        var options = new AgentOptions();
        options.Collection.CpuSampleIntervalMilliseconds = 100;

        var draft = new CheckInDraft();

        await new PerformanceCollector(
                new FakeWmiRepository(), new StubProcessProvider(), TestOptions.Create(options))
            .CollectAsync(
                draft,
                includeProcesses: true,
                includeStartupPrograms: false,
                CancellationToken.None);

        Assert.NotNull(draft.Performance!.Processes);

        // And asking for the processes does not drag the startup programs along
        // with them, which would put a second copy in the action's collected
        // data for nobody to read.
        Assert.Null(draft.Performance.StartupPrograms);
    }

    private static async Task<CheckInDraft> CollectAsync(
        FakeWmiRepository wmi, IProcessProvider processes, CheckInTier tier = CheckInTier.Full)
    {
        var options = new AgentOptions();
        options.Collection.CpuSampleIntervalMilliseconds = 100;

        var draft = new CheckInDraft();
        await new PerformanceCollector(wmi, processes, TestOptions.Create(options))
            .CollectAsync(draft, tier, CancellationToken.None);

        return draft;
    }

    private sealed class StubProcessProvider : IProcessProvider
    {
        public int CallCount { get; private set; }

        public int ProcessorCount => 4;

        public IReadOnlyList<ProcessSnapshot> GetProcesses()
        {
            CallCount++;

            return new[]
            {
                new ProcessSnapshot
                {
                    Pid = 4820,
                    Name = "CubexCabinet",
                    WorkingSetBytes = 256_000_000,
                    ThreadCount = 32,
                    HandleCount = 900,
                    TotalProcessorTime = TimeSpan.FromSeconds(CallCount),
                },
            };
        }
    }
}

public class ProcessCpuCalculatorTests
{
    [Fact]
    public void Combine_DividesConsumedTimeByElapsedTimeAndCoreCount()
    {
        // 400 ms of processor time over 1 s on 4 cores is 10% of the machine.
        var first = new[] { Snapshot(100, TimeSpan.FromSeconds(10)) };
        var second = new[] { Snapshot(100, TimeSpan.FromSeconds(10.4)) };

        var combined = ProcessCpuCalculator.Combine(
            first, second, TimeSpan.FromSeconds(1), processorCount: 4, maximumProcesses: 10);

        Assert.Equal(10.0, Assert.Single(combined).CpuPercent);
    }

    [Fact]
    public void Combine_ReportsNullForAProcessThatStartedBetweenTheSamples()
    {
        // It has no baseline, so it has no measurable rate. Zero would claim it
        // is idle, which is a different and unfounded statement.
        var combined = ProcessCpuCalculator.Combine(
            Array.Empty<ProcessSnapshot>(),
            new[] { Snapshot(200, TimeSpan.FromSeconds(1)) },
            TimeSpan.FromSeconds(1),
            processorCount: 4,
            maximumProcesses: 10);

        Assert.Null(Assert.Single(combined).CpuPercent);
    }

    [Fact]
    public void Combine_ReportsNullWhenProcessorTimeWasRefused()
    {
        var first = new[] { Snapshot(300, null) };
        var second = new[] { Snapshot(300, null) };

        var combined = ProcessCpuCalculator.Combine(
            first, second, TimeSpan.FromSeconds(1), processorCount: 4, maximumProcesses: 10);

        // Access denied on a protected process is expected, not an error, and
        // is reported as an unknown rate rather than an idle one.
        Assert.Null(Assert.Single(combined).CpuPercent);
    }

    [Fact]
    public void Combine_ReportsNullWhenAPidWasRecycled()
    {
        var first = new[] { Snapshot(400, TimeSpan.FromSeconds(50)) };
        var second = new[] { Snapshot(400, TimeSpan.FromSeconds(2)) };

        var combined = ProcessCpuCalculator.Combine(
            first, second, TimeSpan.FromSeconds(1), processorCount: 4, maximumProcesses: 10);

        Assert.Null(Assert.Single(combined).CpuPercent);
    }

    [Fact]
    public void Combine_KeepsTheBusiestProcessesWhenCapped()
    {
        var first = new[]
        {
            Snapshot(1, TimeSpan.Zero, "idle"),
            Snapshot(2, TimeSpan.Zero, "busy"),
        };

        var second = new[]
        {
            Snapshot(1, TimeSpan.FromMilliseconds(10), "idle"),
            Snapshot(2, TimeSpan.FromMilliseconds(900), "busy"),
        };

        var combined = ProcessCpuCalculator.Combine(
            first, second, TimeSpan.FromSeconds(1), processorCount: 1, maximumProcesses: 1);

        Assert.Equal("busy", Assert.Single(combined).Name);
    }

    private static ProcessSnapshot Snapshot(int pid, TimeSpan? processorTime, string name = "test")
        => new()
        {
            Pid = pid,
            Name = name,
            TotalProcessorTime = processorTime,
        };
}

public class EventLogCollectorTests
{
    [Fact]
    public async Task CollectAsync_ReadsAllThreeLogsAndCapsTheTotal()
    {
        var reader = new StubEventLogReader(entriesPerLog: 200);
        var options = new AgentOptions();
        options.Collection.EventLogMaxEntries = 300;
        options.Collection.EventLogWindowHours = 24;

        var draft = new CheckInDraft();
        await new EventLogCollector(reader, TestOptions.Create(options), NullLogger<EventLogCollector>.Instance)
            .CollectAsync(draft, CheckInTier.Full, CancellationToken.None);

        Assert.Equal(
            new[] { EventLogName.Application, EventLogName.System, EventLogName.Security },
            reader.RequestedLogs);

        Assert.Equal(TimeSpan.FromHours(24), reader.RequestedWindow);

        // The cap is divided so a noisy Application log cannot crowd out System.
        Assert.Equal(100, reader.RequestedCap);
        Assert.Equal(300, draft.EventLogs!.Count);
    }

    [Fact]
    public async Task CollectAsync_KeepsTheNewestEntries()
    {
        var reader = new StubEventLogReader(entriesPerLog: 10);
        var options = new AgentOptions();
        options.Collection.EventLogMaxEntries = 3;

        var draft = new CheckInDraft();
        await new EventLogCollector(reader, TestOptions.Create(options), NullLogger<EventLogCollector>.Instance)
            .CollectAsync(draft, CheckInTier.Full, CancellationToken.None);

        var entries = draft.EventLogs!;
        Assert.Equal(3, entries.Count);
        Assert.True(entries[0].TimeCreatedUtc >= entries[1].TimeCreatedUtc);
        Assert.True(entries[1].TimeCreatedUtc >= entries[2].TimeCreatedUtc);
    }

    [Fact]
    public async Task CollectAsync_StillReportsWhenOnlyOneLogIsUnreadable()
    {
        // The Security log needs elevation. A cabinet that cannot read it is
        // still worth a check-in built from the other two.
        var reader = new StubEventLogReader(entriesPerLog: 5)
        {
            FailingLog = EventLogName.Security,
        };

        var draft = new CheckInDraft();
        await new EventLogCollector(
                reader,
                TestOptions.Create(new AgentOptions()),
                NullLogger<EventLogCollector>.Instance)
            .CollectAsync(draft, CheckInTier.Full, CancellationToken.None);

        Assert.Equal(10, draft.EventLogs!.Count);
        Assert.DoesNotContain(draft.EventLogs!, entry => entry.LogName == EventLogName.Security);
    }

    [Fact]
    public async Task CollectAsync_FailsTheSectionOnlyWhenNoLogCanBeRead()
    {
        var reader = new StubEventLogReader(entriesPerLog: 5) { FailAll = true };

        var collector = new EventLogCollector(
            reader,
            TestOptions.Create(new AgentOptions()),
            NullLogger<EventLogCollector>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => collector.CollectAsync(new CheckInDraft(), CheckInTier.Full, CancellationToken.None));
    }

    [Fact]
    public void XPathFilter_SelectsCriticalErrorAndWarningInsideTheWindow()
    {
        var filter = EventLogReader.BuildXPathFilter(TimeSpan.FromHours(24));

        Assert.Contains("Level=1 or Level=2 or Level=3", filter, StringComparison.Ordinal);

        // timediff is in milliseconds. Expressing 24 hours in seconds would
        // silently narrow the window to under half a minute.
        Assert.Contains("timediff(@SystemTime) <= 86400000", filter, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(1, EventLogLevel.Critical)]
    [InlineData(2, EventLogLevel.Error)]
    [InlineData(3, EventLogLevel.Warning)]
    [InlineData(4, EventLogLevel.Information)]
    [InlineData(5, EventLogLevel.Verbose)]
    // Level 0 means the provider did not classify the record, which the
    // Security log does for every audit entry.
    [InlineData(0, EventLogLevel.Unknown)]
    [InlineData(null, EventLogLevel.Unknown)]
    public void MapLevel_TranslatesWindowsLevels(int? level, EventLogLevel expected)
    {
        Assert.Equal(expected, EventLogReader.MapLevel((byte?)level));
    }

    private sealed class StubEventLogReader : IEventLogReader
    {
        private readonly int _entriesPerLog;
        private int _sequence;

        public StubEventLogReader(int entriesPerLog) => _entriesPerLog = entriesPerLog;

        public List<EventLogName> RequestedLogs { get; } = new();

        public TimeSpan RequestedWindow { get; private set; }

        public int RequestedCap { get; private set; }

        public EventLogName? FailingLog { get; set; }

        public bool FailAll { get; set; }

        public IReadOnlyList<EventLogEntry> Read(
            EventLogName log,
            TimeSpan window,
            int maximumEntries,
            CancellationToken cancellationToken)
        {
            RequestedLogs.Add(log);
            RequestedWindow = window;
            RequestedCap = maximumEntries;

            if (FailAll || FailingLog == log)
            {
                throw new UnauthorizedAccessException($"The {log} log is not readable.");
            }

            var baseTime = new DateTimeOffset(2026, 9, 10, 12, 0, 0, TimeSpan.Zero);

            return Enumerable.Range(0, Math.Min(_entriesPerLog, maximumEntries))
                .Select(index => new EventLogEntry
                {
                    LogName = log,
                    EventId = 1000 + index,
                    Level = EventLogLevel.Error,
                    TimeCreatedUtc = baseTime.AddSeconds(-(_sequence++)),
                    Source = "Test",
                })
                .ToArray();
        }
    }
}

public class WindowsUpdateMappingTests
{
    [Theory]
    // WUA's OperationResultCode starts at 0 for "not started" while the
    // contract reserves 0 for "unknown". A cast would report every failed
    // update as having succeeded with errors.
    [InlineData(0, UpdateResultCode.NotStarted)]
    [InlineData(1, UpdateResultCode.InProgress)]
    [InlineData(2, UpdateResultCode.Succeeded)]
    [InlineData(3, UpdateResultCode.SucceededWithErrors)]
    [InlineData(4, UpdateResultCode.Failed)]
    [InlineData(5, UpdateResultCode.Aborted)]
    [InlineData(99, UpdateResultCode.Unknown)]
    [InlineData(null, UpdateResultCode.Unknown)]
    public void MapResultCode_DoesNotSimplyCast(int? wuaCode, UpdateResultCode expected)
    {
        Assert.Equal(expected, WindowsUpdateResultMapping.MapResultCode(wuaCode));
    }

    [Theory]
    [InlineData("Security Updates", UpdateClassification.SecurityUpdate)]
    [InlineData("Critical Updates", UpdateClassification.CriticalUpdate)]
    [InlineData("Definition Updates", UpdateClassification.DefinitionUpdate)]
    [InlineData("Drivers", UpdateClassification.Driver)]
    [InlineData("Update Rollups", UpdateClassification.UpdateRollup)]
    [InlineData("Service Packs", UpdateClassification.ServicePack)]
    [InlineData("Feature Packs", UpdateClassification.FeaturePack)]
    [InlineData("Updates", UpdateClassification.Update)]
    [InlineData("Tools", UpdateClassification.Tool)]
    [InlineData("Upgrades", UpdateClassification.Upgrade)]
    [InlineData("Windows 10", UpdateClassification.Unknown)]
    [InlineData(null, UpdateClassification.Unknown)]
    public void MapClassification_MapsCategoryNames(string? categoryName, UpdateClassification expected)
    {
        Assert.Equal(expected, WindowsUpdateResultMapping.MapClassification(categoryName));
    }

    [Fact]
    public void SelectClassification_PrefersTheMostSpecificCategory()
    {
        // An update belongs to several categories at once. Filing a security
        // update as a generic update is not acceptable on these machines.
        var classification = WindowsUpdateResultMapping.SelectClassification(
            new[] { "Windows 10", "Updates", "Security Updates" });

        Assert.Equal(UpdateClassification.SecurityUpdate, classification);
    }

    [Fact]
    public void SelectClassification_ReturnsUnknownWhenNoCategoryIsRecognised()
    {
        Assert.Equal(
            UpdateClassification.Unknown,
            WindowsUpdateResultMapping.SelectClassification(new[] { "Windows 10", "Windows 11" }));
    }
}

public class WindowsUpdateCollectorTests
{
    [Fact]
    public async Task CollectAsync_ReportsPendingUpdatesHistoryAndPolicy()
    {
        var gateway = new StubWindowsUpdateGateway
        {
            Pending = new[]
            {
                new PendingUpdateInfo
                {
                    UpdateId = "abc",
                    Title = "2026-09 Cumulative Update",
                    Classification = UpdateClassification.SecurityUpdate,
                    IsSecurity = true,
                    SizeBytes = 500_000_000,
                },
            },
            History = new[]
            {
                new UpdateHistoryEntry
                {
                    Title = "2026-08 Cumulative Update",
                    ResultCode = UpdateResultCode.Succeeded,
                    DateUtc = new DateTimeOffset(2026, 8, 14, 3, 0, 0, TimeSpan.Zero),
                },
                new UpdateHistoryEntry
                {
                    Title = "A failed driver",
                    ResultCode = UpdateResultCode.Failed,
                    DateUtc = new DateTimeOffset(2026, 9, 1, 3, 0, 0, TimeSpan.Zero),
                    ErrorCode = -2145124329,
                },
            },
        };

        var registry = new FakeRegistryReader()
            .AddKey(
                @"SOFTWARE\Microsoft\WindowsUpdate\UX\Settings",
                RegistryViewScope.Registry64,
                ("ActiveHoursStart", 8),
                ("ActiveHoursEnd", 18))
            .AddKey(
                @"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate",
                RegistryViewScope.Registry64,
                ("DeferQualityUpdatesPeriodInDays", 7));

        var draft = new CheckInDraft();
        await Collector(gateway, registry).CollectAsync(draft, CheckInTier.Full, CancellationToken.None);

        var update = draft.WindowsUpdate!;
        Assert.Equal(1, update.PendingUpdateCount);
        Assert.Equal(UpdateClassification.SecurityUpdate, Assert.Single(update.PendingUpdates!).Classification);

        // The most recent success, not the most recent entry.
        Assert.Equal(new DateTimeOffset(2026, 8, 14, 3, 0, 0, TimeSpan.Zero), update.LastSuccessfulInstallUtc);

        Assert.Equal(new TimeOnly(8, 0), update.ActiveHoursStart);
        Assert.Equal(new TimeOnly(18, 0), update.ActiveHoursEnd);
        Assert.True(update.IsManagedByPolicy);
        Assert.Equal(7, update.DeferralDays);
        Assert.False(update.RebootPending);
    }

    [Fact]
    public async Task CollectAsync_SearchesOfflineSoARoutineCheckInDoesNotCallOutToWindowsUpdate()
    {
        // A cabinet contacting Windows Update every five minutes would be slow
        // and pointless. The explicit ScanForUpdates action is what asks
        // Windows to actually go and look.
        var gateway = new StubWindowsUpdateGateway();

        await Collector(gateway, new FakeRegistryReader())
            .CollectAsync(new CheckInDraft(), CheckInTier.Full, CancellationToken.None);

        Assert.False(gateway.SearchedOnline);
    }

    [Fact]
    public async Task CollectAsync_DetectsARebootPendingFromEitherKey()
    {
        var autoUpdate = new FakeRegistryReader().AddKey(
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
            RegistryViewScope.Registry64);

        var componentBasedServicing = new FakeRegistryReader().AddKey(
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
            RegistryViewScope.Registry64);

        foreach (var registry in new[] { autoUpdate, componentBasedServicing })
        {
            var draft = new CheckInDraft();
            await Collector(new StubWindowsUpdateGateway(), registry)
                .CollectAsync(draft, CheckInTier.Full, CancellationToken.None);

            Assert.True(draft.WindowsUpdate!.RebootPending);
        }
    }

    [Fact]
    public async Task CollectAsync_StillReportsRebootStateWhenTheUpdateAgentFails()
    {
        // A wedged Windows Update Agent is usually wedged because the machine
        // is waiting to restart, so the cheap registry half must survive the
        // COM half failing.
        var gateway = new StubWindowsUpdateGateway
        {
            Failure = new InvalidOperationException("The Windows Update Agent is not registered."),
        };

        var registry = new FakeRegistryReader().AddKey(
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
            RegistryViewScope.Registry64);

        var draft = new CheckInDraft();
        await Collector(gateway, registry).CollectAsync(draft, CheckInTier.Full, CancellationToken.None);

        Assert.True(draft.WindowsUpdate!.RebootPending);

        // Null, not zero: the search never ran, so the count is unknown.
        Assert.Null(draft.WindowsUpdate.PendingUpdateCount);
        Assert.Null(draft.WindowsUpdate.PendingUpdates);
    }

    private static WindowsUpdateCollector Collector(IWindowsUpdateGateway gateway, IRegistryReader registry)
        => new(gateway, registry, TestOptions.Create(new AgentOptions()), NullLogger<WindowsUpdateCollector>.Instance);

    private sealed class StubWindowsUpdateGateway : IWindowsUpdateGateway
    {
        public IReadOnlyList<PendingUpdateInfo> Pending { get; set; } = Array.Empty<PendingUpdateInfo>();

        public IReadOnlyList<UpdateHistoryEntry> History { get; set; } = Array.Empty<UpdateHistoryEntry>();

        public Exception? Failure { get; set; }

        public bool? SearchedOnline { get; private set; }

        public IReadOnlyList<PendingUpdateInfo> SearchPendingUpdates(bool online, CancellationToken cancellationToken)
        {
            SearchedOnline = online;
            return Failure is not null ? throw Failure : Pending;
        }

        public IReadOnlyList<UpdateHistoryEntry> GetHistory(int maximumEntries, CancellationToken cancellationToken)
            => Failure is not null ? throw Failure : History;
    }
}

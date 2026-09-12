using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;

namespace CabinetPlatform.Agent.Tests.Collectors;

public class SystemCollectorTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 10, 18, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task CollectAsync_ReadsOperatingSystemIdentityAndUptime()
    {
        var wmi = new FakeWmiRepository()
            .Returns(
                "Win32_OperatingSystem",
                FakeWmiRepository.Row(
                    ("Caption", "Microsoft Windows 10 IoT Enterprise LTSC"),
                    ("Version", "10.0.19044"),
                    ("BuildNumber", "19044"),
                    ("InstallDate", "20230114083000.000000-300"),
                    ("LastBootUpTime", "20260908060000.000000+000")))
            .Returns(
                "Win32_ComputerSystem",
                FakeWmiRepository.Row(
                    ("Name", "CABINET-07"),
                    ("Domain", "clinic.example.org"),
                    ("PartOfDomain", true)));

        var draft = await CollectAsync(wmi, new FakeRegistryReader());

        Assert.NotNull(draft.System);
        Assert.Equal("CABINET-07", draft.System!.Hostname);
        Assert.Equal("Microsoft Windows 10 IoT Enterprise LTSC", draft.System.OsVersion);
        Assert.Equal("19044", draft.System.OsBuild);
        Assert.True(draft.System.IsDomainJoined);
        Assert.Equal("clinic.example.org", draft.System.DomainOrWorkgroup);

        // Booted 2026-09-08 06:00Z, now 2026-09-10 18:00Z.
        Assert.Equal(TimeSpan.FromHours(60), draft.System.Uptime);
        Assert.Equal(Now, draft.System.SystemTimeUtc);
        Assert.Equal(TimeZoneInfo.Local.Id, draft.System.TimeZoneId);
    }

    [Fact]
    public async Task CollectAsync_ReportsTheWorkgroupWhenNotDomainJoined()
    {
        var wmi = new FakeWmiRepository()
            .Returns("Win32_OperatingSystem", FakeWmiRepository.Row(("Caption", "Windows 10")))
            .Returns(
                "Win32_ComputerSystem",
                FakeWmiRepository.Row(
                    ("Name", "CABINET-02"),
                    ("Domain", "WORKGROUP"),
                    ("Workgroup", "VETCLINIC"),
                    ("PartOfDomain", false)));

        var draft = await CollectAsync(wmi, new FakeRegistryReader());

        Assert.False(draft.System!.IsDomainJoined);
        Assert.Equal("VETCLINIC", draft.System.DomainOrWorkgroup);
    }

    [Fact]
    public async Task CollectAsync_CountsOnlyInteractiveLogonSessions()
    {
        // Session 4001 is interactive, 9002 is a service logon. Only the first
        // means a person is present, and that distinction is what the reboot
        // guard depends on.
        var wmi = new FakeWmiRepository()
            .Returns("Win32_OperatingSystem", FakeWmiRepository.Row(("Caption", "Windows 10")))
            .Returns("Win32_ComputerSystem", FakeWmiRepository.Row(("Name", "CABINET-07")))
            .Returns(
                "Win32_LogonSession",
                FakeWmiRepository.Row(("LogonId", "4001"), ("LogonType", 2)))
            .Returns(
                "Win32_LoggedOnUser",
                FakeWmiRepository.Row(
                    ("Antecedent", @"\\CABINET-07\root\cimv2:Win32_Account.Domain=""CLINIC"",Name=""jrivera"""),
                    ("Dependent", @"\\CABINET-07\root\cimv2:Win32_LogonSession.LogonId=""4001""")),
                FakeWmiRepository.Row(
                    ("Antecedent", @"\\CABINET-07\root\cimv2:Win32_Account.Domain=""NT AUTHORITY"",Name=""SYSTEM"""),
                    ("Dependent", @"\\CABINET-07\root\cimv2:Win32_LogonSession.LogonId=""9002""")));

        var draft = await CollectAsync(wmi, new FakeRegistryReader());

        Assert.True(draft.System!.AnyUserLoggedOn);
        Assert.Equal(1, draft.System.LoggedOnUserCount);

        // The query must ask WMI to filter, not pull every session back.
        Assert.Contains(wmi.ExecutedQueries, query => query.Contains("LogonType = 2", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CollectAsync_ReportsNobodyLoggedOnWhenThereAreNoInteractiveSessions()
    {
        var wmi = new FakeWmiRepository()
            .Returns("Win32_OperatingSystem", FakeWmiRepository.Row(("Caption", "Windows 10")))
            .Returns("Win32_ComputerSystem", FakeWmiRepository.Row(("Name", "CABINET-07")));

        var draft = await CollectAsync(wmi, new FakeRegistryReader());

        Assert.False(draft.System!.AnyUserLoggedOn);
        Assert.Equal(0, draft.System.LoggedOnUserCount);
    }

    [Fact]
    public async Task CollectAsync_ReadsInstalledSoftwareFromBothRegistryViews()
    {
        const string NativePath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
        const string WowPath = @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

        var registry = new FakeRegistryReader()
            .AddKey(
                $@"{NativePath}\{{A1}}",
                RegistryViewScope.Registry64,
                ("DisplayName", "CUBEX Cabinet Client"),
                ("DisplayVersion", "7.4.1"),
                ("Publisher", "Mashura"),
                ("InstallDate", "20240115"))
            .AddKey(
                $@"{WowPath}\{{B2}}",
                RegistryViewScope.Registry64,
                ("DisplayName", "Legacy Label Printer Driver"),
                ("DisplayVersion", "2.0.0"),
                ("Publisher", "Zebra"));

        var wmi = new FakeWmiRepository()
            .Returns("Win32_OperatingSystem", FakeWmiRepository.Row(("Caption", "Windows 10")))
            .Returns("Win32_ComputerSystem", FakeWmiRepository.Row(("Name", "CABINET-07")));

        var draft = await CollectAsync(wmi, registry);

        var software = draft.System!.InstalledSoftware!;
        Assert.Equal(2, software.Count);

        // The 32-bit entry is the one a native-view-only read would miss.
        Assert.Contains(software, entry => entry.Name == "Legacy Label Printer Driver");

        var client = Assert.Single(software, entry => entry.Name == "CUBEX Cabinet Client");
        Assert.Equal("7.4.1", client.Version);
        Assert.Equal("Mashura", client.Publisher);
        Assert.Equal(new DateTimeOffset(2024, 1, 15, 0, 0, 0, TimeSpan.Zero), client.InstallDate);
    }

    [Fact]
    public async Task CollectAsync_SkipsSystemComponentsAndUpdateEntries()
    {
        const string NativePath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

        var registry = new FakeRegistryReader()
            .AddKey($@"{NativePath}\{{Real}}", RegistryViewScope.Registry64, ("DisplayName", "Real Application"))
            .AddKey(
                $@"{NativePath}\{{Component}}",
                RegistryViewScope.Registry64,
                ("DisplayName", "Some Redistributable"),
                ("SystemComponent", 1))
            .AddKey(
                $@"{NativePath}\{{KB5001}}",
                RegistryViewScope.Registry64,
                ("DisplayName", "Security Update KB5001"),
                ("ParentKeyName", "OperatingSystem"))
            .AddKey($@"{NativePath}\{{NoName}}", RegistryViewScope.Registry64, ("Publisher", "Nobody"));

        var wmi = new FakeWmiRepository()
            .Returns("Win32_OperatingSystem", FakeWmiRepository.Row(("Caption", "Windows 10")))
            .Returns("Win32_ComputerSystem", FakeWmiRepository.Row(("Name", "CABINET-07")));

        var draft = await CollectAsync(wmi, registry);

        var single = Assert.Single(draft.System!.InstalledSoftware!);
        Assert.Equal("Real Application", single.Name);
    }

    private static async Task<CheckInDraft> CollectAsync(FakeWmiRepository wmi, FakeRegistryReader registry)
    {
        var collector = new SystemCollector(
            wmi,
            new InstalledSoftwareReader(registry),
            new LogonSessionReader(wmi),
            new FixedClock(Now),
            TestOptions.Create(new AgentOptions()));

        var draft = new CheckInDraft();
        await collector.CollectAsync(draft, CheckInTier.Full, CancellationToken.None);
        return draft;
    }
}

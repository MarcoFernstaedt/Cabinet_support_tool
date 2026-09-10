using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Server.Tests.Contracts;

/// <summary>
/// Round-trip tests for the check-in contract. The server deserialises these
/// payloads, so what matters here is that an unavailable value arrives as an
/// unavailable value and never as a plausible-looking zero.
/// </summary>
public class CheckInPayloadSerializationTests
{
    /// <summary>
    /// The two option sets the platform actually uses: library defaults, and
    /// the web defaults ASP.NET Core applies to request and response bodies.
    /// Neither registers a custom converter.
    /// </summary>
    public static TheoryData<JsonSerializerOptions> SerializerOptions() =>
    [
        new JsonSerializerOptions(),
        new JsonSerializerOptions(JsonSerializerDefaults.Web),
    ];

    /// <summary>
    /// A payload from a machine where several collectors failed and several
    /// counters were simply not exposed. Every unreadable value is null.
    /// </summary>
    private static CheckInPayload CreatePartialPayload() => new()
    {
        AgentVersion = "1.0.0",
        CabinetId = null,
        MachineId = "b8c1f0d2e3a45566778899aabbccddeeff00112233445566778899aabbccddee",
        CollectedAtUtc = new DateTimeOffset(2026, 3, 14, 9, 30, 0, TimeSpan.Zero),
        System = new SystemInfo
        {
            Hostname = "CBX-CLINIC-04",
            OsVersion = "Windows 11 Pro",
            OsBuild = "22631.4169",
            InstallDateUtc = new DateTimeOffset(2024, 6, 1, 12, 0, 0, TimeSpan.Zero),
            LastBootUtc = new DateTimeOffset(2026, 3, 11, 3, 15, 0, TimeSpan.Zero),
            Uptime = TimeSpan.FromHours(78.25),
            TimeZoneId = "America/Phoenix",
            SystemTimeUtc = new DateTimeOffset(2026, 3, 14, 9, 29, 58, TimeSpan.Zero),
            DomainOrWorkgroup = "MASHURA",
            IsDomainJoined = true,
            AnyUserLoggedOn = null,
            LoggedOnUserCount = null,
            InstalledSoftware = null,
        },
        Performance = new PerformanceInfo
        {
            CpuTotalPercent = 12.5,
            CpuPerCorePercent = [10.0, 15.0],
            RamTotalBytes = 17179869184,
            RamAvailableBytes = null,
            RamUsedPercent = null,
            PageFileTotalBytes = null,
            PageFileUsedBytes = null,
            Processes =
            [
                new ProcessInfo
                {
                    Name = "ZimbisCabinet",
                    Pid = 4821,
                    CpuPercent = null,
                    WorkingSetBytes = 268435456,
                    ThreadCount = null,
                    HandleCount = null,
                },
            ],
            StartupPrograms = null,
        },
        Services =
        [
            new ServiceInfo
            {
                Name = "CabinetSync",
                DisplayName = "Cabinet Sync Service",
                State = ServiceState.Stopped,
                StartType = ServiceStartType.Automatic,
                RunAsAccount = "LocalSystem",
                ProcessId = null,
            },
        ],
        Disks =
        [
            new DiskInfo
            {
                DriveLetter = "C:",
                Label = "OS",
                FileSystem = "NTFS",
                TotalBytes = 511000000000,
                FreeBytes = null,
                FreePercent = null,
                BitLockerStatus = BitLockerStatus.EncryptedUnlocked,
                QueueDepth = null,
                ReadBytesPerSec = null,
                WriteBytesPerSec = null,
                Smart = new SmartInfo
                {
                    ReallocatedSectorCount = null,
                    PendingSectorCount = null,
                    UncorrectableErrorCount = null,
                    PowerOnHours = 19422,
                    TemperatureCelsius = null,
                    OverallPredictFailure = null,
                    SerialNumber = "S3Z9NB0M512345",
                    Model = "Samsung SSD 870 EVO 500GB",
                },
                HealthStatus = DiskHealthStatus.Unknown,
            },
        ],
        EventLogs =
        [
            new EventLogEntry
            {
                LogName = EventLogName.System,
                Source = "Service Control Manager",
                EventId = 7034,
                Level = EventLogLevel.Error,
                TimeCreatedUtc = new DateTimeOffset(2026, 3, 14, 8, 2, 11, TimeSpan.Zero),
                Message = "The CabinetSync service terminated unexpectedly.",
            },
        ],
        WindowsUpdate = new WindowsUpdateInfo
        {
            PendingUpdates =
            [
                new PendingUpdateInfo
                {
                    UpdateId = "b3f0a1e4-2c5d-4a77-9f01-7d0e6a2b1c33",
                    Title = "2026-03 Cumulative Update for Windows 11",
                    Classification = UpdateClassification.SecurityUpdate,
                    IsSecurity = true,
                    SizeBytes = null,
                },
            ],
            PendingUpdateCount = 1,
            LastSuccessfulInstallUtc = null,
            RebootPending = null,
            History = null,
            ActiveHoursStart = new TimeOnly(7, 0),
            ActiveHoursEnd = new TimeOnly(19, 0),
            IsManagedByPolicy = null,
            DeferralDays = null,
        },
        Network = new NetworkInfo
        {
            Adapters =
            [
                new NetworkAdapterInfo
                {
                    Name = "Ethernet",
                    Description = "Intel(R) I219-LM",
                    MacAddress = "00:1A:2B:3C:4D:5E",
                    Status = NetworkAdapterStatus.Up,
                    LinkSpeedBps = 1000000000,
                    IpAddresses = ["10.14.3.22"],
                    SubnetMasks = ["255.255.255.0"],
                    Gateways = ["10.14.3.1"],
                    DnsServers = null,
                    DhcpEnabled = true,
                },
            ],
            ProxyConfigured = false,
            ProxyAddress = null,
            FirewallDomainEnabled = true,
            FirewallPrivateEnabled = true,
            FirewallPublicEnabled = null,
            ServerReachable = true,
            ServerLatencyMs = 41.7,
        },
        CabinetData = null,
        SectionErrors = new Dictionary<string, string>
        {
            ["Performance.StartupPrograms"] = "Access denied reading HKLM Run key.",
            ["WindowsUpdate.History"] = "Windows Update agent COM call timed out.",
        },
    };

    [Theory]
    [MemberData(nameof(SerializerOptions))]
    public void RoundTrip_KeepsUnavailableValuesNull(JsonSerializerOptions options)
    {
        var original = CreatePartialPayload();

        var json = JsonSerializer.Serialize(original, options);
        var restored = JsonSerializer.Deserialize<CheckInPayload>(json, options);

        Assert.NotNull(restored);

        // An agent still waiting for Supervisor approval has no cabinet.
        Assert.Null(restored.CabinetId);

        // The reboot safety gate: unknown must stay unknown, not become false.
        Assert.NotNull(restored.System);
        Assert.Null(restored.System.AnyUserLoggedOn);
        Assert.Null(restored.System.LoggedOnUserCount);
        Assert.Null(restored.System.InstalledSoftware);

        // Unsampled counters stay null rather than reading as an idle machine.
        Assert.NotNull(restored.Performance);
        Assert.Null(restored.Performance.RamAvailableBytes);
        Assert.Null(restored.Performance.RamUsedPercent);
        Assert.Null(restored.Performance.PageFileTotalBytes);
        Assert.Null(restored.Performance.PageFileUsedBytes);
        Assert.Null(restored.Performance.StartupPrograms);
        Assert.Null(Assert.Single(restored.Performance.Processes!).CpuPercent);
        Assert.Null(Assert.Single(restored.Performance.Processes!).ThreadCount);

        // SMART attributes the controller does not expose stay null.
        var disk = Assert.Single(restored.Disks!);
        Assert.Null(disk.FreeBytes);
        Assert.Null(disk.FreePercent);
        Assert.NotNull(disk.Smart);
        Assert.Null(disk.Smart.ReallocatedSectorCount);
        Assert.Null(disk.Smart.PendingSectorCount);
        Assert.Null(disk.Smart.UncorrectableErrorCount);
        Assert.Null(disk.Smart.TemperatureCelsius);
        Assert.Null(disk.Smart.OverallPredictFailure);

        Assert.NotNull(restored.WindowsUpdate);
        Assert.Null(restored.WindowsUpdate.LastSuccessfulInstallUtc);
        Assert.Null(restored.WindowsUpdate.RebootPending);
        Assert.Null(restored.WindowsUpdate.History);
        Assert.Null(Assert.Single(restored.WindowsUpdate.PendingUpdates!).SizeBytes);

        Assert.NotNull(restored.Network);
        Assert.Null(restored.Network.ProxyAddress);
        Assert.Null(restored.Network.FirewallPublicEnabled);
        Assert.Null(Assert.Single(restored.Network.Adapters!).DnsServers);

        // Reserved and deliberately unshaped.
        Assert.Null(restored.CabinetData);
    }

    [Theory]
    [MemberData(nameof(SerializerOptions))]
    public void RoundTrip_KeepsCollectedValues(JsonSerializerOptions options)
    {
        var original = CreatePartialPayload();

        var json = JsonSerializer.Serialize(original, options);
        var restored = JsonSerializer.Deserialize<CheckInPayload>(json, options);

        Assert.NotNull(restored);
        Assert.Equal(original.AgentVersion, restored.AgentVersion);
        Assert.Equal(original.MachineId, restored.MachineId);
        Assert.Equal(original.CollectedAtUtc, restored.CollectedAtUtc);

        Assert.Equal(TimeSpan.FromHours(78.25), restored.System!.Uptime);
        Assert.Equal("America/Phoenix", restored.System.TimeZoneId);
        Assert.True(restored.System.IsDomainJoined);

        Assert.Equal([10.0, 15.0], restored.Performance!.CpuPerCorePercent!);

        var service = Assert.Single(restored.Services!);
        Assert.Equal(ServiceState.Stopped, service.State);
        Assert.Equal(ServiceStartType.Automatic, service.StartType);

        var disk = Assert.Single(restored.Disks!);
        Assert.Equal(BitLockerStatus.EncryptedUnlocked, disk.BitLockerStatus);
        Assert.Equal(DiskHealthStatus.Unknown, disk.HealthStatus);
        Assert.Equal(19422, disk.Smart!.PowerOnHours);

        var entry = Assert.Single(restored.EventLogs!);
        Assert.Equal(EventLogName.System, entry.LogName);
        Assert.Equal(EventLogLevel.Error, entry.Level);
        Assert.Equal(7034, entry.EventId);

        Assert.Equal(new TimeOnly(7, 0), restored.WindowsUpdate!.ActiveHoursStart);
        Assert.Equal(new TimeOnly(19, 0), restored.WindowsUpdate.ActiveHoursEnd);
        Assert.Equal(
            UpdateClassification.SecurityUpdate,
            Assert.Single(restored.WindowsUpdate.PendingUpdates!).Classification);

        var adapter = Assert.Single(restored.Network!.Adapters!);
        Assert.Equal(NetworkAdapterStatus.Up, adapter.Status);
        Assert.Equal(["10.14.3.22"], adapter.IpAddresses!);

        // A partial payload explains its own gaps rather than losing them.
        Assert.Equal(2, restored.SectionErrors.Count);
        Assert.Equal(
            "Access denied reading HKLM Run key.",
            restored.SectionErrors["Performance.StartupPrograms"]);
    }

    [Theory]
    [MemberData(nameof(SerializerOptions))]
    public void Serialize_WritesJsonNull_NotZero_ForUnavailableCounters(JsonSerializerOptions options)
    {
        var json = JsonSerializer.Serialize(CreatePartialPayload(), options);
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        // Each of these is written, and written as null: the reader can tell
        // "we looked and could not read it" from "we never looked".
        var smart = Property(Property(Property(root, "Disks")[0], "Smart"), "ReallocatedSectorCount");
        Assert.Equal(JsonValueKind.Null, smart.ValueKind);

        var ramAvailable = Property(Property(root, "Performance"), "RamAvailableBytes");
        Assert.Equal(JsonValueKind.Null, ramAvailable.ValueKind);

        var anyUserLoggedOn = Property(Property(root, "System"), "AnyUserLoggedOn");
        Assert.Equal(JsonValueKind.Null, anyUserLoggedOn.ValueKind);

        var cabinetId = Property(root, "CabinetId");
        Assert.Equal(JsonValueKind.Null, cabinetId.ValueKind);

        // The whole point: the wire form says "unknown", not "zero" or "false".
        Assert.DoesNotContain("\"ReallocatedSectorCount\":0", json);
        Assert.DoesNotContain("\"reallocatedSectorCount\":0", json);
        Assert.DoesNotContain("\"AnyUserLoggedOn\":false", json);
        Assert.DoesNotContain("\"anyUserLoggedOn\":false", json);
    }

    [Theory]
    [MemberData(nameof(SerializerOptions))]
    public void Deserialize_MissingSections_YieldsNullSectionsAndEmptyErrors(JsonSerializerOptions options)
    {
        const string Json = """
            {
              "AgentVersion": "1.0.0",
              "MachineId": "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0",
              "CollectedAtUtc": "2026-03-14T09:30:00+00:00"
            }
            """;

        var restored = JsonSerializer.Deserialize<CheckInPayload>(Json, options);

        Assert.NotNull(restored);
        Assert.Null(restored.System);
        Assert.Null(restored.Performance);
        Assert.Null(restored.Services);
        Assert.Null(restored.Disks);
        Assert.Null(restored.EventLogs);
        Assert.Null(restored.WindowsUpdate);
        Assert.Null(restored.Network);
        Assert.Null(restored.CabinetId);
        Assert.Null(restored.CabinetData);
        Assert.Empty(restored.SectionErrors);
    }

    [Theory]
    [MemberData(nameof(SerializerOptions))]
    public void Serialize_WritesEnumsByName(JsonSerializerOptions options)
    {
        var json = JsonSerializer.Serialize(CreatePartialPayload(), options);

        // Names, not ordinals: the wire form stays readable in an audit trail
        // and survives members being added to an enum.
        Assert.Contains("\"Stopped\"", json);
        Assert.Contains("\"Automatic\"", json);
        Assert.Contains("\"EncryptedUnlocked\"", json);
        Assert.Contains("\"SecurityUpdate\"", json);
        Assert.DoesNotContain("\"State\":1", json);
        Assert.DoesNotContain("\"state\":1", json);
    }

    [Fact]
    public void Deserialize_ActionNameOutsideTheAllowList_Fails()
    {
        // The catalog is closed. An action nobody implemented cannot be
        // represented in a request, let alone dispatched.
        Assert.Throws<JsonException>(
            () => JsonSerializer.Deserialize<ActionName>("\"OpenDrawer\""));

        Assert.Equal(
            ActionName.RebootMachine,
            JsonSerializer.Deserialize<ActionName>("\"RebootMachine\""));
    }

    /// <summary>
    /// Looks a property up case-insensitively, so one test covers both the
    /// library's PascalCase defaults and ASP.NET Core's camelCase web
    /// defaults. Fails if the property is absent — absent and present-but-null
    /// are different claims and this suite cares about the difference.
    /// </summary>
    private static JsonElement Property(JsonElement element, string name)
    {
        foreach (var property in element.EnumerateObject())
        {
            if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                return property.Value;
            }
        }

        throw new Xunit.Sdk.XunitException($"Property '{name}' was not written to the payload.");
    }
}

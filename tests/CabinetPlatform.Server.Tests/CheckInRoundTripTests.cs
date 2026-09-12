using System.Net;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// A fully populated check-in, serialised by the agent and read by the server,
/// arrives with nothing lost — and a sparsely populated one arrives with its
/// absences still absent.
/// </summary>
/// <remarks>
/// <para>
/// This is the test that catches the whole class of bug the merge was most
/// likely to introduce: a field renamed on one side, a converter registered on
/// one side, an enum encoded as a number by one and read as a name by the
/// other. Every one of those failures is silent. The payload still parses, the
/// check-in still returns 200, and a counter simply stops arriving.
/// </para>
/// <para>
/// It runs against the real ingest endpoint and then reads back what the server
/// actually stored, rather than round-tripping in memory: an in-memory
/// round-trip would pass even if the server discarded the section on the way to
/// the database.
/// </para>
/// </remarks>
public sealed class CheckInRoundTripTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;

    public CheckInRoundTripTests(SupportApiFactory factory) => _factory = factory;

    [Fact]
    public void A_fully_populated_payload_survives_the_agents_serializer_and_the_servers_reader()
    {
        CheckInPayload sent = FullyPopulated("machine-roundtrip-full");

        // Serialised exactly as the agent serialises it: AgentJson.SerializerOptions
        // is this same instance, which is what keeps the two sides from drifting
        // into private dialects. CabinetPlatform.Agent targets net8.0-windows and
        // cannot be referenced from here, so the agent's own test asserts that
        // identity and this test relies on it.
        string agentJson = JsonSerializer.Serialize(sent, ContractJson.Default);

        // Read exactly as the server reads it.
        CheckInPayload? received = JsonSerializer.Deserialize<CheckInPayload>(
            agentJson, ContractJson.Default);

        Assert.NotNull(received);

        // Canonical comparison rather than record equality: these records hold
        // lists and dictionaries, which compare by reference, so Equals would
        // pass trivially on the scalars and say nothing about the collections.
        Assert.Equal(Canonical(sent), Canonical(received!));

        // And nothing arrived null. Stated separately because the comparison
        // above would also pass if both sides were empty.
        List<string> missing = NullProperties(received!, nameof(CheckInPayload)).ToList();

        Assert.True(missing.Count == 0,
            "Properties that arrived null from a fully populated payload: " +
            string.Join(", ", missing));
    }

    [Fact]
    public void Every_absent_reading_is_still_absent_after_the_round_trip()
    {
        // The other half, and the one that matters more. A null counter means
        // "the agent could not read this"; a zero means "the agent read this
        // and it was zero". Anything that turns the first into the second
        // poisons the trend data this platform exists to produce, and does it
        // invisibly — the number looks perfectly plausible.
        CheckInPayload sparse = SparselyPopulated("machine-roundtrip-sparse");

        string agentJson = JsonSerializer.Serialize(sparse, ContractJson.Default);

        CheckInPayload? received = JsonSerializer.Deserialize<CheckInPayload>(
            agentJson, ContractJson.Default);

        Assert.NotNull(received);
        Assert.Equal(Canonical(sparse), Canonical(received!));

        // Every section the payload did not carry is still null.
        Assert.Null(received!.Performance);
        Assert.Null(received.Services);
        Assert.Null(received.EventLogs);
        Assert.Null(received.WindowsUpdate);
        Assert.Null(received.Network);

        // The System section is present but almost every member of it failed to
        // read. Not one of them became a zero, an empty string or a false.
        Assert.NotNull(received.System);
        Assert.Null(received.System!.AnyUserLoggedOn);
        Assert.Null(received.System.Uptime);
        Assert.Null(received.System.LoggedOnUserCount);
        Assert.Null(received.System.IsDomainJoined);
        Assert.Null(received.System.InstalledSoftware);

        // Same for the drive: a drive whose SMART could not be read carries no
        // SmartInfo at all, which is what makes its health Unknown rather than
        // Healthy.
        DiskInfo disk = Assert.Single(received.Disks!);
        Assert.Null(disk.Smart);
        Assert.Null(disk.FreePercent);
        Assert.Null(disk.TotalBytes);
        Assert.Equal(DiskHealthStatus.Unknown, disk.HealthStatus);

        // And the payload says which collectors failed, so the gaps explain
        // themselves rather than looking like a quiet machine.
        Assert.Equal(
            new[] { "EventLogs", "Network", "Performance", "Services", "Smart", "WindowsUpdate" },
            received.SectionErrors.Keys.OrderBy(k => k, StringComparer.Ordinal));
    }

    [Fact]
    public async Task What_the_server_stores_is_what_the_agent_sent()
    {
        // End to end over HTTP, against the real ingest endpoint, reading back
        // the document the server actually persisted. The two tests above prove
        // the serializers agree; this one proves nothing is dropped between the
        // model binder and the database.
        (_, User supervisor) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        string machineId = Unique("roundtrip");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, machineId, supervisor.Id);

        CheckInPayload sent = FullyPopulated(machineId) with { CabinetId = cabinet.Id };

        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        HttpResponseMessage response = await agent.PostAsync(
            "/api/agent/checkin/full",
            new StringContent(
                JsonSerializer.Serialize(sent, ContractJson.Default),
                System.Text.Encoding.UTF8,
                "application/json"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        CheckInResponse? body = await response.ReadAsync<CheckInResponse>();

        // Ruling 7: the server issues the cabinet identity. An agent that has
        // been approved learns which cabinet it is from this field and no other.
        Assert.NotNull(body);
        Assert.Equal(cabinet.Id, body!.CabinetId);

        InventoryVersion stored = await _factory.WithDbAsync(db => db.InventoryVersions
            .AsNoTracking()
            .FirstAsync(v => v.CabinetId == cabinet.Id));

        StoredInventory? persisted = JsonSerializer.Deserialize<StoredInventory>(
            stored.PayloadJson, ContractJson.Default);

        Assert.NotNull(persisted);

        // The inventory document holds the configuration sections verbatim.
        Assert.Equal(Canonical(sent.System!), Canonical(persisted!.System!));
        Assert.Equal(Canonical(sent.Services!), Canonical(persisted.Services!));
        Assert.Equal(Canonical(sent.Network!), Canonical(persisted.Network!));
        Assert.Equal(Canonical(sent.WindowsUpdate!), Canonical(persisted.WindowsUpdate!));
        Assert.Equal(Canonical(sent.Disks!), Canonical(persisted.Disks!));

        // Installed memory and the startup programs are configuration and are
        // kept. The counters beside them in the same section are a sample taken
        // at one instant, ride the heartbeat, and are deliberately absent: an
        // inventory that changed every time CPU utilisation moved would defeat
        // the whole point of storing inventory only when it changes.
        Assert.NotNull(persisted.Performance);
        Assert.Equal(sent.Performance!.RamTotalBytes, persisted.Performance!.RamTotalBytes);
        Assert.Equal(
            Canonical(sent.Performance.StartupPrograms!),
            Canonical(persisted.Performance.StartupPrograms!));

        Assert.Null(persisted.Performance.CpuTotalPercent);
        Assert.Null(persisted.Performance.RamUsedPercent);
        Assert.Null(persisted.Performance.Processes);

        // The heartbeat is where that sample lives, and it arrived intact.
        Heartbeat beat = await _factory.WithDbAsync(db => db.Heartbeats
            .AsNoTracking()
            .FirstAsync(h => h.CabinetId == cabinet.Id));

        Assert.Equal(sent.Performance.CpuTotalPercent, beat.CpuPercent);
        Assert.Equal(sent.Performance.RamUsedPercent, beat.RamUsedPercent);
        Assert.Equal(sent.System!.AnyUserLoggedOn, beat.AnyUserLoggedOn);
        Assert.Equal(sent.WindowsUpdate!.PendingUpdateCount, beat.PendingUpdateCount);
        Assert.Equal(sent.WindowsUpdate.RebootPending, beat.RebootPending);

        // The SMART series is stored in its own typed rows, not in the JSON, so
        // it is checked where it actually lives.
        SmartReading reading = await _factory.WithDbAsync(db => db.SmartReadings
            .AsNoTracking()
            .FirstAsync(s => s.CabinetId == cabinet.Id));

        SmartInfo smart = sent.Disks!.Single(d => d.Smart is not null).Smart!;

        Assert.Equal(smart.SerialNumber, reading.DriveSerial);
        Assert.Equal(smart.Source, reading.Source);
        Assert.Equal(smart.ReallocatedSectorCount, reading.ReallocatedSectorCount);
        Assert.Equal(smart.PendingSectorCount, reading.PendingSectorCount);
        Assert.Equal(smart.UncorrectableErrorCount, reading.UncorrectableErrorCount);
        Assert.Equal(smart.PowerOnHours, reading.PowerOnHours);
        Assert.Equal(smart.TemperatureCelsius, reading.TemperatureCelsius);
        Assert.Equal(smart.TemperatureMax, reading.TemperatureMax);
        Assert.Equal(smart.Wear, reading.Wear);
        Assert.Equal(smart.ReadErrorsTotal, reading.ReadErrorsTotal);
        Assert.Equal(smart.ReadErrorsUncorrected, reading.ReadErrorsUncorrected);
        Assert.Equal(smart.WriteErrorsTotal, reading.WriteErrorsTotal);
        Assert.Equal(smart.WriteErrorsUncorrected, reading.WriteErrorsUncorrected);
        Assert.Equal(smart.StartStopCycleCount, reading.StartStopCycleCount);
        Assert.Equal(smart.OverallPredictFailure, reading.OverallPredictFailure);
        Assert.Equal(smart.PredictFailureReason, reading.PredictFailureReason);
    }

    [Fact]
    public async Task A_null_counter_stays_null_all_the_way_into_the_database()
    {
        // The same journey as above, taken by a payload full of absences. The
        // failure this guards against is a projection that reads
        // `payload.System?.AnyUserLoggedOn ?? false` somewhere between the
        // controller and the column.
        (_, User supervisor) =
            await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Unique("sup"));

        string machineId = Unique("sparse");
        Cabinet cabinet = await TestClient.CreateApprovedCabinetAsync(_factory, machineId, supervisor.Id);

        CheckInPayload sparse = SparselyPopulated(machineId) with { CabinetId = cabinet.Id };

        HttpClient agent = TestClient.CreateAgentClient(_factory, machineId);

        HttpResponseMessage response = await agent.PostAsync(
            "/api/agent/checkin/full",
            new StringContent(
                JsonSerializer.Serialize(sparse, ContractJson.Default),
                System.Text.Encoding.UTF8,
                "application/json"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Heartbeat beat = await _factory.WithDbAsync(db => db.Heartbeats
            .AsNoTracking()
            .FirstAsync(h => h.CabinetId == cabinet.Id));

        Assert.Null(beat.AnyUserLoggedOn);
        Assert.Null(beat.CpuPercent);
        Assert.Null(beat.RamUsedPercent);
        Assert.Null(beat.MinFreeDiskPercent);
        Assert.Null(beat.PendingUpdateCount);
        Assert.Null(beat.RebootPending);
        Assert.Null(beat.UptimeSeconds);

        // Unknown, not Healthy. A drive whose SMART could not be read is a
        // drive nobody has checked.
        Assert.Equal(DiskHealthStatus.Unknown, beat.WorstDiskHealth);

        // No SMART row at all, rather than a row of zeroes. A zeroed row would
        // enter the failure-prediction series as a pristine drive and would drag
        // every trend built on it towards "fine".
        Assert.False(await _factory.WithDbAsync(db => db.SmartReadings
            .AsNoTracking()
            .AnyAsync(s => s.CabinetId == cabinet.Id)));
    }

    /// <summary>
    /// A payload with every section present and every optional member of every
    /// section filled in.
    /// </summary>
    private static CheckInPayload FullyPopulated(string machineId) => new()
    {
        MachineId = machineId,
        AgentVersion = "1.4.2",
        CollectedAtUtc = new DateTimeOffset(2026, 3, 1, 12, 0, 0, TimeSpan.Zero),

        System = new SystemInfo
        {
            Hostname = "CUBEX-RT-01",
            OsVersion = "Windows 11 Enterprise 23H2",
            OsBuild = "22631.3737",
            InstallDateUtc = new DateTimeOffset(2024, 5, 2, 9, 15, 0, TimeSpan.Zero),
            LastBootUtc = new DateTimeOffset(2026, 2, 27, 6, 30, 0, TimeSpan.Zero),
            Uptime = TimeSpan.FromHours(53.5),
            TimeZoneId = "America/Chicago",
            SystemTimeUtc = new DateTimeOffset(2026, 3, 1, 12, 0, 3, TimeSpan.Zero),
            DomainOrWorkgroup = "RIVERSIDE",
            IsDomainJoined = true,
            AnyUserLoggedOn = true,
            LoggedOnUserCount = 2,
            InstalledSoftware = new[]
            {
                new InstalledSoftwareInfo
                {
                    Name = "CUBEX Dispense Client",
                    Version = "8.4.1",
                    Publisher = "CUBEX LLC",
                    InstallDate = new DateTimeOffset(2025, 11, 3, 0, 0, 0, TimeSpan.Zero),
                },
            },
        },

        Performance = new PerformanceInfo
        {
            CpuTotalPercent = 22.5,
            CpuPerCorePercent = new[] { 18.0, 27.25, 19.5, 25.0 },
            RamTotalBytes = 17_179_869_184,
            RamAvailableBytes = 6_484_000_000,
            RamUsedPercent = 62.25,
            PageFileTotalBytes = 4_294_967_296,
            PageFileUsedBytes = 912_000_000,
            Processes = new[]
            {
                new ProcessInfo
                {
                    Name = "CubexDispense.exe",
                    Pid = 4812,
                    CpuPercent = 3.5,
                    WorkingSetBytes = 284_000_000,
                    ThreadCount = 42,
                    HandleCount = 1_204,
                },
            },
            StartupPrograms = new[]
            {
                new StartupProgramInfo
                {
                    Name = "CubexAgent",
                    Command = @"C:\Program Files\CUBEX\agent.exe --service",
                    Location = @"HKLM\Software\Microsoft\Windows\CurrentVersion\Run",
                },
            },
        },

        Services = new[]
        {
            new ServiceInfo
            {
                Name = "MashuraCabinetAgent",
                DisplayName = "Mashura Cabinet Agent",
                State = ServiceState.Running,
                StartType = ServiceStartType.Automatic,
                RunAsAccount = "LocalSystem",
                ProcessId = 3120,
            },
        },

        Disks = new[]
        {
            new DiskInfo
            {
                DriveLetter = "C",
                Label = "System",
                FileSystem = "NTFS",
                TotalBytes = 255_000_000_000,
                FreeBytes = 107_100_000_000,
                FreePercent = 42,
                BitLockerStatus = BitLockerStatus.EncryptedUnlocked,
                QueueDepth = 0.4,
                ReadBytesPerSec = 1_250_000,
                WriteBytesPerSec = 480_000,
                HealthStatus = DiskHealthStatus.Watch,
                Smart = new SmartInfo
                {
                    Source = SmartSource.StorageReliabilityCounter,
                    SerialNumber = "S4EVNF0M123456",
                    Model = "SAMSUNG MZ7LH256",
                    ReallocatedSectorCount = 12,
                    PendingSectorCount = 3,
                    UncorrectableErrorCount = 1,
                    PowerOnHours = 14_500,
                    TemperatureCelsius = 41,
                    TemperatureMax = 58,
                    OverallPredictFailure = false,
                    PredictFailureReason = 0,
                    Wear = 7,
                    ReadErrorsTotal = 1_204,
                    ReadErrorsUncorrected = 0,
                    WriteErrorsTotal = 18,
                    WriteErrorsUncorrected = 0,
                    StartStopCycleCount = 412,
                },
            },
        },

        EventLogs = new[]
        {
            new EventLogEntry
            {
                LogName = EventLogName.System,
                Source = "Service Control Manager",
                EventId = 7034,
                Level = EventLogLevel.Error,
                TimeCreatedUtc = new DateTimeOffset(2026, 3, 1, 4, 22, 11, TimeSpan.Zero),
                Message = "The Mashura Dispense Controller service terminated unexpectedly.",
            },
        },

        WindowsUpdate = new WindowsUpdateInfo
        {
            PendingUpdateCount = 2,
            LastSuccessfulInstallUtc = new DateTimeOffset(2026, 2, 12, 3, 0, 0, TimeSpan.Zero),
            RebootPending = true,
            ActiveHoursStart = new TimeOnly(7, 0),
            ActiveHoursEnd = new TimeOnly(19, 0),
            IsManagedByPolicy = true,
            DeferralDays = 7,
            PendingUpdates = new[]
            {
                new PendingUpdateInfo
                {
                    UpdateId = "KB5034123",
                    Title = "2026-02 Cumulative Update for Windows 11",
                    Classification = UpdateClassification.SecurityUpdate,
                    IsSecurity = true,
                    SizeBytes = 742_000_000,
                },
            },
            History = new[]
            {
                new UpdateHistoryEntry
                {
                    Title = "2026-01 Cumulative Update for Windows 11",
                    ResultCode = UpdateResultCode.Succeeded,
                    DateUtc = new DateTimeOffset(2026, 1, 14, 3, 12, 0, TimeSpan.Zero),
                    ErrorCode = 0,
                },
            },
        },

        Network = new NetworkInfo
        {
            ProxyConfigured = true,
            ProxyAddress = "proxy.riverside.local:8080",
            FirewallDomainEnabled = true,
            FirewallPrivateEnabled = true,
            FirewallPublicEnabled = false,
            ServerReachable = true,
            ServerLatencyMs = 18.4,
            Adapters = new[]
            {
                new NetworkAdapterInfo
                {
                    Name = "Ethernet",
                    Description = "Intel(R) Ethernet Connection I219-LM",
                    MacAddress = "00:1A:2B:3C:4D:5E",
                    Status = NetworkAdapterStatus.Up,
                    LinkSpeedBps = 1_000_000_000,
                    IpAddresses = new[] { "10.20.30.41" },
                    SubnetMasks = new[] { "255.255.255.0" },
                    Gateways = new[] { "10.20.30.1" },
                    DnsServers = new[] { "10.20.30.2", "10.20.30.3" },
                    DhcpEnabled = true,
                },
            },
        },

        // What the machine actually did with an install this platform asked
        // for, as distinct from the fact that one was scheduled. It rides every
        // tier, because an install finishes when it finishes rather than when a
        // full check-in happens to be due.
        UpdateInstallOutcomes = new[]
        {
            new UpdateInstallOutcome
            {
                ActionRequestId = Guid.Parse("6f1a2b3c-4d5e-4f60-8172-9a0b1c2d3e4f"),
                CompletedUtc = new DateTimeOffset(2026, 9, 11, 2, 41, 0, TimeSpan.Zero),
                RebootRequired = true,
                Results = new[]
                {
                    new UpdateInstallResult
                    {
                        UpdateId = "c1b2a3d4-5e6f-4071-8293-a4b5c6d7e8f9",
                        Title = "2026-09 Cumulative Update for Windows 10 (KB5099999)",
                        ResultCode = UpdateResultCode.SucceededWithErrors,

                        // Populated on both results, because this test's whole
                        // point is that every property survives the trip. A
                        // succeeded install with no error code would leave one
                        // nullable field untested.
                        ErrorCode = unchecked((int)0x8024200D),
                    },
                    new UpdateInstallResult
                    {
                        UpdateId = "d2c3b4a5-6f70-4182-93a4-b5c6d7e8f9a0",
                        Title = "2026-09 Servicing Stack Update",
                        ResultCode = UpdateResultCode.Failed,
                        ErrorCode = unchecked((int)0x80240022),
                    },
                },
            },
        },

        SectionErrors = new Dictionary<string, string>
        {
            ["CabinetData"] = "Sensor and drawer discovery is not implemented in this build.",
        },
    };

    /// <summary>
    /// A payload from a cabinet where nearly every collector failed: one
    /// section, one drive, and almost nothing readable on either.
    /// </summary>
    private static CheckInPayload SparselyPopulated(string machineId) => new()
    {
        MachineId = machineId,
        AgentVersion = "1.4.2",
        CollectedAtUtc = new DateTimeOffset(2026, 3, 1, 12, 0, 0, TimeSpan.Zero),

        System = new SystemInfo
        {
            Hostname = "CUBEX-RT-02",

            // Everything else on this machine failed to read, including the one
            // value that gates reboots.
        },

        Disks = new[]
        {
            new DiskInfo
            {
                DriveLetter = "C",
                BitLockerStatus = BitLockerStatus.Unknown,
                HealthStatus = DiskHealthStatus.Unknown,
            },
        },

        SectionErrors = new Dictionary<string, string>
        {
            ["Performance"] = "The performance counter library returned no data.",
            ["Services"] = "Access denied enumerating services.",
            ["EventLogs"] = "The event log service is not running.",
            ["WindowsUpdate"] = "The Windows Update agent COM object could not be created.",
            ["Network"] = "WMI query for network adapters timed out.",
            ["Smart"] = "No SMART source answered for any drive.",
        },
    };

    /// <summary>
    /// Serialises an object to JSON with its properties in a fixed order, so two
    /// objects can be compared for structural equality including their lists and
    /// dictionaries.
    /// </summary>
    private static string Canonical(object value) =>
        Sort(JsonNode.Parse(JsonSerializer.Serialize(value, ContractJson.Default))!).ToJsonString();

    private static JsonNode Sort(JsonNode node)
    {
        switch (node)
        {
            case JsonObject o:
                var sorted = new JsonObject();

                foreach (KeyValuePair<string, JsonNode?> pair in
                         o.OrderBy(p => p.Key, StringComparer.Ordinal).ToList())
                {
                    o.Remove(pair.Key);
                    sorted[pair.Key] = pair.Value is null ? null : Sort(pair.Value);
                }

                return sorted;

            case JsonArray a:
                var items = new JsonArray();

                foreach (JsonNode? item in a.ToList())
                {
                    a.Remove(item);
                    items.Add(item is null ? null : Sort(item));
                }

                return items;

            default:
                return node;
        }
    }

    /// <summary>
    /// Walks an object graph and names every property that is null.
    /// </summary>
    /// <remarks>
    /// Reflection rather than a written-out list of assertions, so that a
    /// property added to a contract tomorrow is covered by this test the moment
    /// it exists — which is the only way a test like this stays true.
    /// </remarks>
    private static IEnumerable<string> NullProperties(object value, string path)
    {
        Type type = value.GetType();

        if (type.Assembly != typeof(CheckInPayload).Assembly)
        {
            yield break;
        }

        foreach (PropertyInfo property in type.GetProperties(
                     BindingFlags.Public | BindingFlags.Instance))
        {
            // CabinetData is untyped and deliberately always null in this
            // build: the cabinet hardware telemetry shape is not designed yet
            // and must not be guessed at.
            if (property.Name == nameof(CheckInPayload.CabinetData) ||
                property.Name == nameof(CheckInPayload.CabinetId))
            {
                continue;
            }

            object? member = property.GetValue(value);
            string memberPath = $"{path}.{property.Name}";

            if (member is null)
            {
                yield return memberPath;
                continue;
            }

            if (member is System.Collections.IEnumerable sequence and not string)
            {
                var index = 0;

                foreach (object? item in sequence)
                {
                    if (item is not null)
                    {
                        foreach (string nested in NullProperties(item, $"{memberPath}[{index}]"))
                        {
                            yield return nested;
                        }
                    }

                    index++;
                }

                continue;
            }

            foreach (string nested in NullProperties(member, memberPath))
            {
                yield return nested;
            }
        }
    }

    private static string Unique(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..24];

    /// <summary>
    /// The shape of the document the server stores for one inventory version.
    /// </summary>
    /// <remarks>
    /// Declared here rather than reusing the server's own private record, so
    /// that a change to what the server stores shows up as a failing assertion
    /// in this test instead of being silently agreed to by both sides.
    /// </remarks>
    private sealed record StoredInventory
    {
        public SystemInfo? System { get; init; }

        public IReadOnlyList<ServiceInfo>? Services { get; init; }

        public NetworkInfo? Network { get; init; }

        public WindowsUpdateInfo? WindowsUpdate { get; init; }

        public IReadOnlyList<DiskInfo>? Disks { get; init; }

        public PerformanceInfo? Performance { get; init; }
    }
}

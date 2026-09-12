using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Domain;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>Payloads shaped like the ones a real agent sends.</summary>
/// <remarks>
/// Counters a real cabinet can fail to read are left <see langword="null"/>
/// wherever the scenario calls for it, never defaulted to zero. The console's
/// job is to make an absent reading look absent, and a fixture that quietly
/// fills every field would leave that untested.
/// </remarks>
public static class TestData
{
    public static CheckInPayload Payload(
        string machineId,
        DateTimeOffset collectedAtUtc,
        double cpuPercent = 17.5,
        double ramUsedPercent = 62.25,
        bool? anyUserLoggedOn = false,
        int pendingUpdates = 3,
        bool includeServices = true,
        bool includeVolumes = true) =>
        new()
        {
            MachineId = machineId,
            AgentVersion = "1.4.2",
            CollectedAtUtc = collectedAtUtc,

            System = new SystemInfo
            {
                Hostname = "CUBEX-NG-01",
                OsVersion = "Windows 10 Enterprise LTSC 21H2",
                OsBuild = "19044.3086",
                Uptime = TimeSpan.FromHours(53.5),
                AnyUserLoggedOn = anyUserLoggedOn,
                TimeZoneId = "Europe/London",
                SystemTimeUtc = collectedAtUtc,
                IsDomainJoined = true,
                DomainOrWorkgroup = "NORTHGATE",
            },

            Performance = new PerformanceInfo
            {
                CpuTotalPercent = cpuPercent,
                RamUsedPercent = ramUsedPercent,
                RamTotalBytes = 17_179_869_184,
                RamAvailableBytes = 6_484_000_000,
            },

            Disks = includeVolumes
                ? new[]
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
                        HealthStatus = DiskHealthStatus.Healthy,
                    },
                    new DiskInfo
                    {
                        // Deliberately nearly full: exercises the low-space
                        // wording rather than only the happy path.
                        DriveLetter = "D",
                        Label = "Data",
                        FileSystem = "NTFS",
                        TotalBytes = 500_000_000_000,
                        FreeBytes = 10_000_000_000,
                        FreePercent = 2,
                        BitLockerStatus = BitLockerStatus.NotEncrypted,
                        HealthStatus = DiskHealthStatus.Watch,
                    },
                }
                : Array.Empty<DiskInfo>(),

            WindowsUpdate = new WindowsUpdateInfo
            {
                PendingUpdateCount = pendingUpdates,
                RebootPending = pendingUpdates > 0,
                PendingUpdates = Enumerable.Range(1, pendingUpdates)
                    .Select(i => new PendingUpdateInfo
                    {
                        UpdateId = $"KB50{i:D5}",
                        Title = $"Cumulative update {i} for Windows 10",
                        Classification = i % 2 == 1
                            ? UpdateClassification.SecurityUpdate
                            : UpdateClassification.Update,
                        IsSecurity = i % 2 == 1,
                    })
                    .ToArray(),
            },

            Services = includeServices
                ? new[]
                {
                    new ServiceInfo
                    {
                        Name = "MashuraCabinetAgent",
                        DisplayName = "Mashura Cabinet Agent",
                        State = ServiceState.Running,
                        StartType = ServiceStartType.Automatic,
                    },
                    new ServiceInfo
                    {
                        // The case support staff hunt for.
                        Name = "MashuraDispenseController",
                        DisplayName = "Mashura Dispense Controller",
                        State = ServiceState.Stopped,
                        StartType = ServiceStartType.Automatic,
                    },
                    new ServiceInfo
                    {
                        Name = "Spooler",
                        DisplayName = "Print Spooler",
                        State = ServiceState.Running,
                        StartType = ServiceStartType.Automatic,
                    },
                    new ServiceInfo
                    {
                        Name = "BITS",
                        DisplayName = "Background Intelligent Transfer",
                        State = ServiceState.Stopped,
                        StartType = ServiceStartType.Manual,
                    },
                    new ServiceInfo
                    {
                        // The state could not be read: must render as "Not
                        // reported", never as stopped. Unknown is the enum's
                        // zero precisely so that a failed read cannot pass for
                        // a service somebody has deliberately turned off.
                        Name = "W32Time",
                        DisplayName = "Windows Time",
                        State = ServiceState.Unknown,
                        StartType = ServiceStartType.Automatic,
                    },
                }
                : Array.Empty<ServiceInfo>(),

            Network = new NetworkInfo
            {
                ProxyConfigured = false,
                FirewallDomainEnabled = true,
                FirewallPrivateEnabled = true,
                FirewallPublicEnabled = true,
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
                    new NetworkAdapterInfo
                    {
                        // Present but unplugged. It must read as down rather
                        // than be filtered out: a satellite cabinet on the wrong
                        // port is exactly what a rep is looking for.
                        Name = "Wi-Fi",
                        Description = "Intel(R) Wireless-AC 9560",
                        Status = NetworkAdapterStatus.Down,
                        DhcpEnabled = true,
                    },
                },
            },
        };

    /// <summary>
    /// A rotational drive whose reallocated sector count is climbing — the trend
    /// the Disk section exists to make visible.
    /// </summary>
    public static IEnumerable<SmartReading> RisingReallocations(
        string serial, DateTimeOffset startUtc, int days) =>
        Enumerable.Range(0, days).Select(day => new SmartReading
        {
            DriveSerial = serial,
            DriveModel = "SEAGATE ST1000NM",
            TimestampUtc = startUtc.AddDays(day),
            Health = day < 3 ? DiskHealthStatus.Healthy : DiskHealthStatus.Watch,

            // Decoded out of the vendor byte array, which is the only source a
            // rotational drive behind this controller offers.
            Source = SmartSource.FailurePredictData,
            ReallocatedSectorCount = day * 8,
            PendingSectorCount = day > 4 ? 2 : 0,
            PowerOnHours = 20_000 + day * 24,
            TemperatureCelsius = 38 + (day % 3),

            // That source carries none of the structured counters. They stay
            // absent rather than becoming zero, which on a wear figure would
            // read as a factory-fresh drive.
            Wear = null,
            ReadErrorsTotal = null,
            ReadErrorsUncorrected = null,
            WriteErrorsTotal = null,
            WriteErrorsUncorrected = null,
            TemperatureMax = null,
            StartStopCycleCount = null,
        });

    /// <summary>
    /// An NVMe module behind a driver that implements the structured
    /// reliability counters, which report the other half of the attribute set.
    /// </summary>
    public static SmartReading NvmeReading(string serial, DateTimeOffset timestampUtc) => new()
    {
        DriveSerial = serial,
        DriveModel = "SAMSUNG MZVLB256",
        TimestampUtc = timestampUtc,
        Health = DiskHealthStatus.Healthy,
        Source = SmartSource.StorageReliabilityCounter,
        Wear = 7,
        ReadErrorsTotal = 1_204,
        ReadErrorsUncorrected = 0,
        WriteErrorsTotal = 18,
        WriteErrorsUncorrected = 0,
        StartStopCycleCount = 412,
        PowerOnHours = 9_112,
        TemperatureCelsius = 41,
        TemperatureMax = 58,

        // Reports no rotational attributes at all.
        ReallocatedSectorCount = null,
        PendingSectorCount = null,
        UncorrectableErrorCount = null,
    };
}

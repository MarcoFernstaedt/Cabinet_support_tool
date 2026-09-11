using CabinetPlatform.Contracts.Agent;
using CabinetPlatform.Contracts.Enums;
using CabinetPlatform.Server.Domain;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>Payloads shaped like the ones a real agent sends.</summary>
public static class TestData
{
    public static CheckInRequest Payload(
        string machineId,
        DateTime collectedAtUtc,
        double cpuPercent = 17.5,
        double ramUsedPercent = 62.25,
        bool anyUserLoggedOn = false,
        int pendingUpdates = 3,
        bool includeServices = true,
        bool includeVolumes = true) =>
        new()
        {
            MachineId = machineId,
            CollectedAtUtc = collectedAtUtc,
            Hostname = "CUBEX-NG-01",
            AgentVersion = "1.4.2",
            OsVersion = "Windows 10 Enterprise LTSC 21H2",
            CpuPercent = cpuPercent,
            RamUsedPercent = ramUsedPercent,
            RamTotalBytes = 17_179_869_184,
            Uptime = TimeSpan.FromHours(53.5),
            AnyUserLoggedOn = anyUserLoggedOn,

            Volumes = includeVolumes
                ? new List<VolumeSnapshot>
                {
                    new()
                    {
                        VolumeId = "C:", Label = "System", FileSystem = "NTFS",
                        TotalBytes = 255_000_000_000, FreeBytes = 107_100_000_000
                    },
                    new()
                    {
                        // Deliberately nearly full: exercises the low-space
                        // wording rather than only the happy path.
                        VolumeId = "D:", Label = "Data", FileSystem = "NTFS",
                        TotalBytes = 500_000_000_000, FreeBytes = 10_000_000_000
                    }
                }
                : new List<VolumeSnapshot>(),

            PendingUpdates = Enumerable.Range(1, pendingUpdates)
                .Select(i => new PendingUpdateSnapshot
                {
                    UpdateId = $"KB50{i:D5}",
                    Title = $"Cumulative update {i} for Windows 10",
                    IsSecurityUpdate = i % 2 == 1,
                    RequiresReboot = i == 1
                })
                .ToList(),

            Services = includeServices
                ? new List<ServiceSnapshot>
                {
                    new()
                    {
                        ServiceName = "MashuraCabinetAgent", DisplayName = "Mashura Cabinet Agent",
                        Status = "Running", StartMode = "Auto"
                    },
                    new()
                    {
                        // The case support staff hunt for.
                        ServiceName = "MashuraDispenseController",
                        DisplayName = "Mashura Dispense Controller",
                        Status = "Stopped", StartMode = "Auto"
                    },
                    new()
                    {
                        ServiceName = "Spooler", DisplayName = "Print Spooler",
                        Status = "Running", StartMode = "Auto"
                    },
                    new()
                    {
                        ServiceName = "BITS", DisplayName = "Background Intelligent Transfer",
                        Status = "Stopped", StartMode = "Manual"
                    },
                    new()
                    {
                        // No status at all: must render as "Not reported",
                        // never as stopped.
                        ServiceName = "W32Time", DisplayName = "Windows Time",
                        Status = null, StartMode = "Auto"
                    }
                }
                : new List<ServiceSnapshot>()
        };

    /// <summary>
    /// A rotational drive whose reallocated sector count is climbing — the trend
    /// the Disk section exists to make visible.
    /// </summary>
    public static IEnumerable<SmartReading> RisingReallocations(
        string serial, DateTime startUtc, int days) =>
        Enumerable.Range(0, days).Select(day => new SmartReading
        {
            DriveSerial = serial,
            DriveModel = "SEAGATE ST1000NM",
            TimestampUtc = startUtc.AddDays(day),
            PredictedHealth = day < 3 ? DiskHealthStatus.Healthy : DiskHealthStatus.Warning,
            ReallocatedSectorCount = day * 8,
            CurrentPendingSectorCount = day > 4 ? 2 : 0,
            PowerOnHours = 20_000 + day * 24,
            PowerCycleCount = 412,
            TemperatureCelsius = 38 + (day % 3),
            // Never reports NVMe attributes: they must stay absent, not zero.
            PercentageUsed = null,
            AvailableSparePercent = null
        });

    /// <summary>An NVMe module, which reports the other half of the attribute set.</summary>
    public static SmartReading NvmeReading(string serial, DateTime timestampUtc) => new()
    {
        DriveSerial = serial,
        DriveModel = "SAMSUNG MZVLB256",
        TimestampUtc = timestampUtc,
        PredictedHealth = DiskHealthStatus.Healthy,
        PercentageUsed = 7,
        AvailableSparePercent = 100,
        AvailableSpareThresholdPercent = 10,
        MediaAndDataIntegrityErrors = 0,
        UnsafeShutdownCount = 14,
        PowerOnHours = 9_112,
        TemperatureCelsius = 41,
        // Reports no rotational attributes at all.
        ReallocatedSectorCount = null,
        CurrentPendingSectorCount = null
    };
}

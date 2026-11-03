using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Windows;

/// <summary>The reads that need the broker's rights: event logs, Windows Update, disk health and files.list.</summary>
[SupportedOSPlatform("windows")]
public static class BrokerReadOperations
{
    private const int MaxEntries = 200_000;

    /// <summary>The operations the broker serves, for its request handler.</summary>
    public static OperationRegistry Registry() => new OperationRegistry()
        .Register<EmptyParams, EventlogChannelsOutput>(Catalog.EventlogChannels, EventLogOperations.ChannelsAsync)
        .Register<EventlogQueryParams, EventlogQueryOutput>(Catalog.EventlogQuery, EventLogOperations.QueryAsync)
        .Register<BootHistoryParams, BootHistoryOutput>(Catalog.BootHistory, EventLogOperations.BootHistoryAsync)
        .Register<EventlogGetParams, EventlogGetOutput>(Catalog.EventlogGet, EventLogOperations.GetAsync)
        .Register<EmptyParams, UpdatesStatusOutput>(Catalog.UpdatesStatus, SystemOperations.UpdatesStatusAsync)
        .Register<EmptyParams, DiskSmartOutput>(Catalog.DiskSmart, DiskSmartAsync)
        .Register<FilesListParams, FilesListOutput>(Catalog.FilesList, FilesListAsync)
        .Register<EmptyParams, SystemPerformanceOutput>(Catalog.SystemPerformance, new LiveReadings().PerformanceAsync)
        .Register<EmptyParams, NetworkListenersOutput>(Catalog.NetworkListeners, new LiveReadings().ListenersAsync);

    /// <summary>
    /// Lists one directory on C:. Listing only: no file is opened. The path
    /// and every directory above it must be ordinary directories, because a
    /// junction or symbolic link could lead the listing somewhere else.
    /// </summary>
    public static Task<FilesListOutput> FilesListAsync(FilesListParams p, CancellationToken token)
    {
        string path = FilesListing.Canonical(p.Path)
            ?? throw new OperationFailedException("not_found", "That path names a device or is not a plain directory path.");
        foreach (string directory in FilesListing.SelfAndAncestors(path))
        {
            FileAttributes attributes;
            try { attributes = File.GetAttributes(directory); }
            catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
            {
                throw new OperationFailedException("not_found", "That directory does not exist.");
            }
            catch (Exception e) when (e is UnauthorizedAccessException or IOException)
            {
                throw new OperationFailedException("execution_failed", "Windows refused access to that directory.");
            }
            if ((attributes & FileAttributes.Directory) == 0) throw new OperationFailedException("not_found", "That path is a file, not a directory.");
            if (directory != "C:\\" && (attributes & FileAttributes.ReparsePoint) != 0)
                throw new OperationFailedException("unavailable", "That path goes through a link or junction, which files.list does not follow.");
        }

        var entries = new List<FileEntry>();
        var options = new EnumerationOptions { RecurseSubdirectories = false, IgnoreInaccessible = true, AttributesToSkip = 0, ReturnSpecialDirectories = false };
        foreach (FileSystemInfo info in new DirectoryInfo(path).EnumerateFileSystemInfos("*", options))
        {
            token.ThrowIfCancellationRequested();
            if (entries.Count >= MaxEntries) break;
            if (info.Name.Length is 0 or > 256 || info.Name.Any(char.IsControl)) continue;
            bool isDirectory = (info.Attributes & FileAttributes.Directory) != 0;
            entries.Add(new FileEntry
            {
                Name = info.Name,
                Type = isDirectory ? FileEntryType.Directory : FileEntryType.File,
                SizeBytes = isDirectory ? null : ((FileInfo)info).Length,
                ModifiedAt = info.LastWriteTimeUtc.Year > 1601 ? new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero) : null,
            });
        }
        int page = p.Page ?? 1;
        var (slice, hasMore) = FilesListing.Page(entries, page, p.PageSize ?? 100);
        return Task.FromResult(new FilesListOutput { Path = path, Page = page, Entries = slice, HasMore = hasMore });
    }

    /// <summary>
    /// Drive health from Storage Management (MSFT_PhysicalDisk and its
    /// reliability counters), with the drive's own SMART failure prediction
    /// and attribute table where the controller exposes them.
    /// </summary>
    public static Task<DiskSmartOutput> DiskSmartAsync(EmptyParams _, CancellationToken token)
    {
        var disks = Wmi.Query(Wmi.Storage, "SELECT DeviceId, FriendlyName, Model, SerialNumber, HealthStatus FROM MSFT_PhysicalDisk", 32);
        var counters = TryQuery(Wmi.Storage, "SELECT DeviceId, Temperature, PowerOnHours, Wear, ReadErrorsUncorrected, WriteErrorsUncorrected FROM MSFT_StorageReliabilityCounter")
            .Where(r => r.Text("DeviceId") is not null).GroupBy(r => r.Text("DeviceId")!).ToDictionary(g => g.Key, g => g.First());
        var drives = TryQuery(Wmi.CimV2, "SELECT Index, PNPDeviceID FROM Win32_DiskDrive");
        var predict = TryQuery(Wmi.RootWmi, "SELECT InstanceName, PredictFailure FROM MSStorageDriver_FailurePredictStatus");
        var tables = TryQuery(Wmi.RootWmi, "SELECT InstanceName, VendorSpecific FROM MSStorageDriver_FailurePredictData");

        var output = new List<DriveSmart>();
        foreach (var disk in disks)
        {
            token.ThrowIfCancellationRequested();
            string? number = disk.Text("DeviceId");
            counters.TryGetValue(number ?? "", out var counter);
            // root\wmi instance names start with the drive's PnP device ID, matched to the disk number through Win32_DiskDrive.
            string? pnp = drives.FirstOrDefault(d => d.Long("Index")?.ToString(System.Globalization.CultureInfo.InvariantCulture) == number)?.Text("PNPDeviceID");
            bool Matches(Dictionary<string, object?> row) =>
                pnp is not null && row.Text("InstanceName") is { } name && name.StartsWith(pnp, StringComparison.OrdinalIgnoreCase);
            bool? predictFailure = predict.FirstOrDefault(Matches)?.Bool("PredictFailure");
            var raw = SmartDecoder.RawValues(tables.FirstOrDefault(Matches) is { } t && t["VendorSpecific"] is byte[] bytes ? bytes : null);

            long? reallocated = SmartDecoder.Value(raw, SmartDecoder.ReallocatedSectors);
            long? pending = SmartDecoder.Value(raw, SmartDecoder.PendingSectors);
            long? uncorrectable = SmartDecoder.Value(raw, SmartDecoder.Uncorrectable)
                ?? Sum(counter?.Long("ReadErrorsUncorrected"), counter?.Long("WriteErrorsUncorrected"));
            int? temperature = counter?.Long("Temperature") is { } c and > 0 and < 125 ? (int)c : SmartDecoder.TemperatureCelsius(raw);
            output.Add(new DriveSmart
            {
                Model = Short(disk.Text("FriendlyName") ?? disk.Text("Model")),
                SerialNumber = Short(disk.Text("SerialNumber")),
                Health = SmartDecoder.Health((int?)disk.Long("HealthStatus"), predictFailure, reallocated, pending),
                PredictFailure = predictFailure,
                TemperatureCelsius = temperature,
                PowerOnHours = NonNegative(counter?.Long("PowerOnHours") ?? SmartDecoder.Value(raw, SmartDecoder.PowerOnHours)),
                ReallocatedSectors = NonNegative(reallocated),
                PendingSectors = NonNegative(pending),
                UncorrectableErrors = NonNegative(uncorrectable),
                WearPercent = counter?.Long("Wear") is { } w and >= 0 and <= 100 ? (int)w : null,
            });
        }
        return Task.FromResult(new DiskSmartOutput { Drives = output });
    }

    private static List<Dictionary<string, object?>> TryQuery(string scope, string wql)
    {
        try { return Wmi.Query(scope, wql, 64); }
        catch (Exception e) when (e is System.Management.ManagementException or UnauthorizedAccessException or System.Runtime.InteropServices.COMException)
        {
            return new List<Dictionary<string, object?>>(); // the class does not exist on this controller or Windows build
        }
    }

    private static long? Sum(long? a, long? b) => a is null && b is null ? null : (a ?? 0) + (b ?? 0);
    private static long? NonNegative(long? v) => v is >= 0 ? v : null;
    private static string? Short(string? text) => text is null ? null : EventText.ShortText(text);
}

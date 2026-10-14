using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Windows;

/// <summary>
/// system.performance and network.listeners: how hard the cabinet is working and what it is listening on. Every WQL text is a
/// constant; a part whose query fails is left out (zeros, empty lists) instead of failing the whole read.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class LiveReadings
{
    private const string StandardCim = @"root\StandardCimv2";

    public Task<SystemPerformanceOutput> PerformanceAsync(EmptyParams _, CancellationToken token)
    {
        double cpuUsed = 0, queue = -1;
        long total = 0, available = 0, committed = -1, limit = -1;
        double pages = -1;
        var volumes = new List<PerformanceVolume>();
        var disks = new List<PerformanceDisk>();
        var processes = new List<PerformanceProcess>();

        Try(() => { if (One("SELECT PercentProcessorTime FROM Win32_PerfFormattedData_PerfOS_Processor WHERE Name = '_Total'") is { } r) cpuUsed = r.Long("PercentProcessorTime") ?? 0; });
        Try(() => { if (One("SELECT ProcessorQueueLength FROM Win32_PerfFormattedData_PerfOS_System") is { } r && r.Long("ProcessorQueueLength") is { } q) queue = q; });
        Try(() =>
        {
            if (One("SELECT TotalVisibleMemorySize, FreePhysicalMemory FROM Win32_OperatingSystem") is not { } r) return;
            total = (r.Long("TotalVisibleMemorySize") ?? 0) * 1024;
            available = (r.Long("FreePhysicalMemory") ?? 0) * 1024;
        });
        Try(() =>
        {
            if (One("SELECT CommittedBytes, CommitLimit, PagesPersec FROM Win32_PerfFormattedData_PerfOS_Memory") is not { } r) return;
            committed = r.Long("CommittedBytes") ?? -1;
            limit = r.Long("CommitLimit") ?? -1;
            pages = r.Long("PagesPersec") ?? -1;
        });
        Try(() =>
        {
            foreach (var r in Wmi.Query(Wmi.CimV2, "SELECT DeviceID, VolumeName, FileSystem, Size, FreeSpace FROM Win32_LogicalDisk WHERE DriveType = 3", 32))
            {
                string? id = r.Text("DeviceID");
                if (id is not { Length: 2 } || !char.IsAsciiLetter(id[0]) || id[1] != ':') continue;
                long size = r.Long("Size") ?? 0, free = r.Long("FreeSpace") ?? 0;
                volumes.Add(new PerformanceVolume { Drive = id.ToUpperInvariant(), Label = Clip(r.Text("VolumeName")), FileSystem = Clip(r.Text("FileSystem")), SizeBytes = size, FreeBytes = Math.Min(free, size) });
            }
        });
        Try(() =>
        {
            foreach (var r in Wmi.Query(Wmi.CimV2, "SELECT Name, PercentDiskTime, CurrentDiskQueueLength, DiskReadsPersec, DiskWritesPersec FROM Win32_PerfFormattedData_PerfDisk_PhysicalDisk", 33))
            {
                string name = r.Text("Name") ?? "disk";
                if (name == "_Total" || disks.Count == 32) continue;
                disks.Add(new PerformanceDisk
                {
                    Name = Clip(name)!, BusyPercent = Math.Clamp(r.Long("PercentDiskTime") ?? 0, 0, 100), QueueLength = Math.Max(0, r.Long("CurrentDiskQueueLength") ?? 0),
                    ReadsPerSecond = Math.Max(0, r.Long("DiskReadsPersec") ?? 0), WritesPerSecond = Math.Max(0, r.Long("DiskWritesPersec") ?? 0),
                });
            }
        });
        Try(() =>
        {
            foreach (var r in Wmi.Query(Wmi.CimV2, "SELECT Name, IDProcess, PercentProcessorTime, WorkingSet FROM Win32_PerfFormattedData_PerfProc_Process", 1024))
            {
                string name = r.Text("Name") ?? "";
                if (name is "_Total" or "Idle" or "") continue;
                processes.Add(new PerformanceProcess { Name = Clip(name)!, Id = Math.Max(0, r.Long("IDProcess") ?? 0), CpuPercent = Math.Clamp(r.Long("PercentProcessorTime") ?? 0, 0, 10000), WorkingSetBytes = Math.Max(0, r.Long("WorkingSet") ?? 0) });
            }
        });

        return Task.FromResult(new SystemPerformanceOutput
        {
            TakenAt = DateTimeOffset.UtcNow,
            Cpu = new PerformanceCpu { UsedPercent = Math.Clamp(cpuUsed, 0, 100), LogicalProcessors = Math.Clamp(Environment.ProcessorCount, 1, 1024), QueueLength = queue < 0 ? null : queue },
            Memory = new PerformanceMemory
            {
                TotalBytes = total, AvailableBytes = Math.Min(available, total), CommittedBytes = committed < 0 ? null : committed,
                CommitLimitBytes = limit < 0 ? null : limit, PagesPerSecond = pages < 0 ? null : pages,
            },
            Volumes = volumes,
            PhysicalDisks = disks,
            ByCpu = processes.OrderByDescending(p => p.CpuPercent).ThenBy(p => p.Id).Take(8).ToList(),
            ByMemory = processes.OrderByDescending(p => p.WorkingSetBytes).ThenBy(p => p.Id).Take(8).ToList(),
        });
    }

    public Task<NetworkListenersOutput> ListenersAsync(EmptyParams _, CancellationToken token)
    {
        var listeners = new List<ListeningPort>();
        var established = new List<EstablishedConnection>();
        long listening = 0, establishedCount = 0, timeWait = 0;
        bool truncated = false;
        var names = new Dictionary<long, string?>();

        Try(() =>
        {
            foreach (var r in Wmi.Query(StandardCim, "SELECT LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess FROM MSFT_NetTCPConnection", 5000))
            {
                long state = r.Long("State") ?? 0, pid = r.Long("OwningProcess") ?? -1;
                long? owner = pid > 0 ? pid : null;
                if (r.Long("LocalPort") is not { } local || local is < 1 or > 65535) continue;
                switch (state)
                {
                    case 2:
                        listening++;
                        if (listeners.Count < 300 && r.Text("LocalAddress") is { } address) listeners.Add(new ListeningPort { Protocol = "tcp", Address = Clip(address)!, Port = (int)local, ProcessId = owner, Process = NameOf(owner, names) });
                        else truncated = true;
                        break;
                    case 5:
                        establishedCount++;
                        if (established.Count < 100 && r.Text("RemoteAddress") is { } remote && r.Long("RemotePort") is { } rp && rp is >= 1 and <= 65535)
                            established.Add(new EstablishedConnection { RemoteAddress = Clip(remote)!, RemotePort = (int)rp, ProcessId = owner, Process = NameOf(owner, names) });
                        else truncated = true;
                        break;
                    case 11: timeWait++; break;
                }
            }
        });
        return Task.FromResult(new NetworkListenersOutput
        {
            TakenAt = DateTimeOffset.UtcNow,
            Listeners = listeners.OrderBy(l => l.Port).ThenBy(l => l.Address, StringComparer.Ordinal).ToList(),
            Established = established,
            Counts = new ConnectionCounts { Established = establishedCount, TimeWait = timeWait, Listening = listening },
            Truncated = truncated,
        });
    }

    private static Dictionary<string, object?>? One(string wql) => Wmi.Query(Wmi.CimV2, wql, 1).FirstOrDefault();

    private static string? Clip(string? text) => text is null ? null : text.Length > 200 ? text[..200] : text;

    private static string? NameOf(long? pid, Dictionary<long, string?> cache)
    {
        if (pid is not { } id) return null;
        if (cache.TryGetValue(id, out string? known)) return known;
        string? name = null;
        try { using Process p = Process.GetProcessById((int)id); name = Clip(p.ProcessName); }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
        return cache[id] = name;
    }

    private static void Try(Action read)
    {
        try { read(); }
        catch (Exception e) when (e is ManagementException or System.Runtime.InteropServices.COMException or UnauthorizedAccessException or InvalidOperationException) { }
    }
}

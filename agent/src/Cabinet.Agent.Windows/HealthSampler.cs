using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Windows;

/// <summary>
/// One small load sample for each heartbeat: processor use since the previous sample, memory in use and free space on the system drive.
/// Plain Windows calls that need no rights; no WMI, so it is cheap enough for every minute.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class HealthSampler
{
    private HealthMath.CpuTimes? _last;

    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low, High; public ulong Value => ((ulong)High << 32) | Low; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length, MemoryLoad;
        public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetSystemTimes(out FileTime idle, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    /// <summary>The sample, or null while there is only one processor reading (the first call) or Windows will not say.</summary>
    public HealthSample? Sample()
    {
        if (!GetSystemTimes(out FileTime idle, out FileTime kernel, out FileTime user)) return null;
        var now = new HealthMath.CpuTimes(idle.Value, kernel.Value, user.Value);
        HealthMath.CpuTimes? before = _last;
        _last = now;
        if (before is not { } b || HealthMath.CpuPercent(b, now) is not { } cpu) return null;
        var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        if (!GlobalMemoryStatusEx(ref memory)) return null;
        try
        {
            var drive = new DriveInfo(Path.GetPathRoot(Environment.SystemDirectory) ?? "C:\\");
            if (HealthMath.FreePercent(drive.AvailableFreeSpace, drive.TotalSize) is not { } free) return null;
            return new HealthSample { CpuPercent = cpu, MemoryUsedPercent = HealthMath.Clamp((int)memory.MemoryLoad), DiskFreePercent = free };
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException) { return null; }
    }
}

namespace Cabinet.Agent.Core.Helpers;

/// <summary>The arithmetic behind the heartbeat's load sample, kept apart from Windows so it can be tested with plain numbers.</summary>
public static class HealthMath
{
    /// <summary>Processor times as Windows reports them (GetSystemTimes): kernel time includes idle time.</summary>
    public readonly record struct CpuTimes(ulong Idle, ulong Kernel, ulong User);

    /// <summary>Whole percent busy between two readings; null when the counters did not move forward (a wrap, a first reading or the same instant).</summary>
    public static int? CpuPercent(CpuTimes before, CpuTimes after)
    {
        if (after.Idle < before.Idle || after.Kernel < before.Kernel || after.User < before.User) return null;
        ulong total = (after.Kernel - before.Kernel) + (after.User - before.User);
        if (total == 0) return null;
        ulong idle = after.Idle - before.Idle;
        if (idle > total) return 0;
        return Clamp((int)Math.Round((total - idle) * 100.0 / total));
    }

    public static int Clamp(int percent) => Math.Clamp(percent, 0, 100);

    /// <summary>Free space as a whole percent of the drive; null for a drive that reports no size.</summary>
    public static int? FreePercent(long freeBytes, long totalBytes) =>
        totalBytes <= 0 || freeBytes < 0 ? null : Clamp((int)Math.Round(Math.Min(freeBytes, totalBytes) * 100.0 / totalBytes));
}

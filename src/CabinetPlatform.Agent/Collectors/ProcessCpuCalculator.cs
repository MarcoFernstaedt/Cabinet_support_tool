using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Turns two process snapshots taken a known interval apart into per-process
/// CPU percentages.
/// </summary>
/// <remarks>
/// A process's <c>TotalProcessorTime</c> is cumulative since it started, so a
/// single reading says how busy a process has been over its whole life, not how
/// busy it is now. Only the difference between two readings, divided by the
/// wall-clock time between them and by the number of logical processors, is the
/// "percent of this machine" figure a support engineer expects to see.
/// </remarks>
public static class ProcessCpuCalculator
{
    public static IReadOnlyList<ProcessInfo> Combine(
        IReadOnlyList<ProcessSnapshot> first,
        IReadOnlyList<ProcessSnapshot> second,
        TimeSpan elapsed,
        int processorCount,
        int maximumProcesses)
    {
        var baseline = new Dictionary<int, ProcessSnapshot>(first.Count);
        foreach (var snapshot in first)
        {
            baseline[snapshot.Pid] = snapshot;
        }

        var effectiveProcessors = processorCount < 1 ? 1 : processorCount;
        var results = new List<ProcessInfo>(second.Count);

        foreach (var current in second)
        {
            results.Add(new ProcessInfo
            {
                Name = current.Name,
                Pid = current.Pid,
                SelectionIdentity = current.SelectionIdentity,
                WorkingSetBytes = current.WorkingSetBytes,
                ThreadCount = current.ThreadCount,
                HandleCount = current.HandleCount,
                CpuPercent = CalculatePercent(
                    baseline.TryGetValue(current.Pid, out var previous) ? previous : null,
                    current,
                    elapsed,
                    effectiveProcessors),
            });
        }

        // The busiest processes are the reason anyone opens this section, and
        // an unbounded list would dominate the payload on a busy machine.
        return results
            .OrderByDescending(process => process.CpuPercent ?? -1)
            .ThenByDescending(process => process.WorkingSetBytes ?? 0)
            .Take(maximumProcesses)
            .ToArray();
    }

    private static double? CalculatePercent(
        ProcessSnapshot? previous,
        ProcessSnapshot current,
        TimeSpan elapsed,
        int processorCount)
    {
        // A process that started between the two samples, or whose processor
        // time was unreadable, has no measurable rate. Unknown, not zero.
        if (previous?.TotalProcessorTime is null ||
            current.TotalProcessorTime is null ||
            elapsed <= TimeSpan.Zero)
        {
            return null;
        }

        var consumed = current.TotalProcessorTime.Value - previous.TotalProcessorTime.Value;
        if (consumed < TimeSpan.Zero)
        {
            // The pid was recycled onto a different process between samples.
            return null;
        }

        var percent = consumed.TotalMilliseconds / (elapsed.TotalMilliseconds * processorCount) * 100.0;

        // Rounding keeps the payload readable; clamping absorbs the small
        // overshoot that timer granularity produces on a fully loaded core.
        return Math.Round(Math.Clamp(percent, 0.0, 100.0), 2);
    }
}

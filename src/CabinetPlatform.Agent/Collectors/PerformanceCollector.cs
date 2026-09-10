using System.Diagnostics;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Processor, memory, page file and process load.
/// </summary>
/// <remarks>
/// Processor and per-process figures are both rates, and a rate needs two
/// samples. The collector takes a baseline, waits the configured interval, and
/// samples again. This is the same reason a <c>PerformanceCounter</c>'s first
/// read is always zero: there is nothing to compare the first reading against.
/// Taking one sample and reporting it would show every cabinet as idle.
/// </remarks>
public sealed class PerformanceCollector : ICollector
{
    private const string TotalInstanceName = "_Total";

    /// <summary>WMI reports memory sizes in kilobytes.</summary>
    private const long KilobytesToBytes = 1024L;

    /// <summary>Win32_PageFileUsage reports sizes in megabytes.</summary>
    private const long MegabytesToBytes = 1024L * 1024L;

    private readonly IWmiRepository _wmi;
    private readonly IProcessProvider _processes;
    private readonly CollectionOptions _options;

    public PerformanceCollector(
        IWmiRepository wmi,
        IProcessProvider processes,
        IOptions<AgentOptions> options)
    {
        _wmi = wmi;
        _processes = processes;
        _options = options.Value.Collection;
    }

    public string SectionName => CollectorSections.Performance;

    public async Task CollectAsync(CheckInDraft draft, CancellationToken cancellationToken)
    {
        var sampleInterval = TimeSpan.FromMilliseconds(_options.CpuSampleIntervalMilliseconds);

        // Baseline for both the processor counters and the per-process rates.
        var firstProcessorSample = ReadProcessorSamples();
        var firstProcessSample = _processes.GetProcesses();
        var stopwatch = Stopwatch.StartNew();

        await Task.Delay(sampleInterval, cancellationToken).ConfigureAwait(false);

        stopwatch.Stop();
        var secondProcessorSample = ReadProcessorSamples();
        var secondProcessSample = _processes.GetProcesses();

        // The second sample is the one reported: the formatted performance
        // classes need a preceding read to have a baseline to format against.
        var processorSample = secondProcessorSample.Count > 0 ? secondProcessorSample : firstProcessorSample;

        var operatingSystem = _wmi.Query(
                WmiScopes.CimV2,
                "SELECT TotalVisibleMemorySize, FreePhysicalMemory FROM Win32_OperatingSystem")
            .FirstOrDefault();

        var totalRamKb = operatingSystem?.GetInt64("TotalVisibleMemorySize");
        var freeRamKb = operatingSystem?.GetInt64("FreePhysicalMemory");

        var totalRamBytes = totalRamKb * KilobytesToBytes;
        var freeRamBytes = freeRamKb * KilobytesToBytes;

        var (pageFileTotal, pageFileUsed) = ReadPageFile();

        draft.Performance = new PerformanceInfo
        {
            CpuTotalPercent = processorSample
                .FirstOrDefault(sample => sample.Name == TotalInstanceName)?.Percent,

            CpuPerCorePercent = processorSample
                .Where(sample => sample.Name != TotalInstanceName)
                .OrderBy(sample => sample.Ordinal)
                .Select(sample => sample.Percent)
                .ToArray(),

            RamTotalBytes = totalRamBytes,
            RamAvailableBytes = freeRamBytes,
            RamUsedPercent = totalRamBytes is > 0 && freeRamBytes is not null
                ? Math.Round((totalRamBytes.Value - freeRamBytes.Value) / (double)totalRamBytes.Value * 100.0, 2)
                : null,

            PageFileTotalBytes = pageFileTotal,
            PageFileUsedBytes = pageFileUsed,

            Processes = ProcessCpuCalculator.Combine(
                firstProcessSample,
                secondProcessSample,
                stopwatch.Elapsed,
                _processes.ProcessorCount,
                _options.MaxProcesses),

            StartupPrograms = ReadStartupPrograms(),
        };
    }

    private sealed record ProcessorSample(string Name, int Ordinal, double Percent);

    private IReadOnlyList<ProcessorSample> ReadProcessorSamples()
    {
        var rows = _wmi.Query(
            WmiScopes.CimV2,
            "SELECT Name, PercentProcessorTime FROM Win32_PerfFormattedData_PerfOS_Processor");

        var samples = new List<ProcessorSample>(rows.Count);

        foreach (var row in rows)
        {
            var name = row.GetString("Name");
            var percent = row.GetDouble("PercentProcessorTime");
            if (name is null || percent is null)
            {
                continue;
            }

            samples.Add(new ProcessorSample(
                name,
                int.TryParse(name, out var ordinal) ? ordinal : int.MaxValue,
                Math.Round(Math.Clamp(percent.Value, 0.0, 100.0), 2)));
        }

        return samples;
    }

    private (long? Total, long? Used) ReadPageFile()
    {
        var rows = _wmi.Query(
            WmiScopes.CimV2,
            "SELECT AllocatedBaseSize, CurrentUsage FROM Win32_PageFileUsage");

        if (rows.Count == 0)
        {
            // A machine can legitimately run with no page file. Reporting
            // nothing is correct; reporting zero used of zero total is not.
            return (null, null);
        }

        long? total = null;
        long? used = null;

        foreach (var row in rows)
        {
            var allocated = row.GetInt64("AllocatedBaseSize");
            var current = row.GetInt64("CurrentUsage");

            if (allocated is not null)
            {
                total = (total ?? 0) + (allocated.Value * MegabytesToBytes);
            }

            if (current is not null)
            {
                used = (used ?? 0) + (current.Value * MegabytesToBytes);
            }
        }

        return (total, used);
    }

    private IReadOnlyList<StartupProgramInfo> ReadStartupPrograms()
    {
        return _wmi.Query(WmiScopes.CimV2, "SELECT Name, Command, Location, User FROM Win32_StartupCommand")
            .Select(row => new
            {
                Name = row.GetString("Name"),
                Command = row.GetString("Command"),
                Location = row.GetString("Location"),
            })
            .Where(entry => entry.Name is not null)
            .Select(entry => new StartupProgramInfo
            {
                Name = entry.Name!,
                Command = entry.Command,
                Location = entry.Location,
            })
            .ToArray();
    }
}

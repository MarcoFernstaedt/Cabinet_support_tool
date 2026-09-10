using System.ComponentModel.DataAnnotations;

namespace CabinetPlatform.Agent.Configuration;

/// <summary>
/// Everything about the agent's behaviour that a deployment is allowed to
/// change. Nothing here is a secret: the agent authenticates to the server with
/// material supplied by the machine's own secret store, never from a committed
/// file.
/// </summary>
public sealed class AgentOptions
{
    public const string SectionName = "Agent";

    /// <summary>Base address of the support server. Outbound only.</summary>
    public string ServerBaseUrl { get; set; } = string.Empty;

    /// <summary>Nominal seconds between check-ins, before jitter.</summary>
    public int CheckInIntervalSeconds { get; set; } = 300;

    /// <summary>
    /// Percentage by which each individual check-in interval is randomly
    /// spread. Cabinets that all boot together after a site power event would
    /// otherwise check in in lockstep and spike the server every interval.
    /// </summary>
    public int CheckInJitterPercent { get; set; } = 5;

    /// <summary>Directory holding the machine id, cabinet id and action journal.</summary>
    public string StateDirectory { get; set; } = "state";

    /// <summary>Directory the agent's own rolling logs are written to.</summary>
    public string LogDirectory { get; set; } = "logs";

    public BufferOptions Buffer { get; set; } = new();

    public BackoffOptions Backoff { get; set; } = new();

    public CollectionOptions Collection { get; set; } = new();

    public ActionOptions Actions { get; set; } = new();
}

/// <summary>
/// Bounds on the offline payload spool. A cabinet's disk filling up because the
/// server was unreachable over a long weekend would turn a monitoring tool into
/// the outage it is meant to report, so the spool is capped on both axes and
/// the oldest payloads are dropped first.
/// </summary>
public sealed class BufferOptions
{
    public string Directory { get; set; } = "buffer";

    [Range(1, 100_000)]
    public int MaxFileCount { get; set; } = 500;

    [Range(1, 100_000)]
    public int MaxTotalMegabytes { get; set; } = 64;
}

/// <summary>
/// Retry pacing for a server that is down. The ceiling matters as much as the
/// growth: without it a fleet recovering from an outage would arrive as a
/// thundering herd.
/// </summary>
public sealed class BackoffOptions
{
    [Range(1, 3600)]
    public int InitialSeconds { get; set; } = 30;

    [Range(1, 86_400)]
    public int MaximumSeconds { get; set; } = 1800;

    [Range(1.0, 10.0)]
    public double Multiplier { get; set; } = 2.0;
}

/// <summary>Limits that keep a single check-in payload a reasonable size.</summary>
public sealed class CollectionOptions
{
    [Range(1, 168)]
    public int EventLogWindowHours { get; set; } = 24;

    [Range(1, 10_000)]
    public int EventLogMaxEntries { get; set; } = 300;

    [Range(1, 2000)]
    public int MaxProcesses { get; set; } = 200;

    [Range(1, 10_000)]
    public int MaxInstalledSoftware { get; set; } = 1000;

    /// <summary>
    /// The Windows Update Agent's COM surface is slow and occasionally hangs on
    /// a machine mid-servicing. It runs off the critical path under this
    /// timeout so a stalled scan delays nothing else.
    /// </summary>
    [Range(5, 900)]
    public int WindowsUpdateTimeoutSeconds { get; set; } = 120;

    [Range(1, 120)]
    public int ServerReachabilityTimeoutSeconds { get; set; } = 5;

    /// <summary>
    /// Sampling gap between the two processor reads. A PerformanceCounter's
    /// first read is always zero, so a single read would report an idle machine
    /// no matter how loaded it is.
    /// </summary>
    [Range(100, 10_000)]
    public int CpuSampleIntervalMilliseconds { get; set; } = 500;
}

/// <summary>
/// Action execution limits and the agent's own copy of the service allow-list.
/// </summary>
public sealed class ActionOptions
{
    [Range(1, 3600)]
    public int DefaultTimeoutSeconds { get; set; } = 120;

    /// <summary>Per-action timeout overrides, keyed by <c>ActionName</c>.</summary>
    public Dictionary<string, int> TimeoutSecondsByAction { get; set; } = new();

    /// <summary>
    /// Service names this agent will start, stop or restart. The server
    /// validates the target too; this list exists so that a compromised or
    /// simply buggy server still cannot reach a service outside it.
    /// </summary>
    public List<string> ServiceAllowList { get; set; } = new();

    /// <summary>Grace period given to users before a reboot proceeds.</summary>
    [Range(0, 600)]
    public int RebootDelaySeconds { get; set; } = 60;

    /// <summary>Directory diagnostic bundles are written to.</summary>
    public string DiagnosticBundleDirectory { get; set; } = "bundles";

    /// <summary>How far ahead of now a scheduled update install may be set.</summary>
    [Range(1, 90)]
    public int MaxUpdateScheduleDays { get; set; } = 30;
}

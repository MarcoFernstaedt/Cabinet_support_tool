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

    /// <summary>Opt-in office token file. When set, never uses the shared fleet environment key.</summary>
    public string? OfficeEnrollmentFile { get; set; }

    /// <summary>Nominal seconds between heartbeats, before jitter.</summary>
    public int CheckInIntervalSeconds { get; set; } = 300;

    /// <summary>
    /// Nominal seconds between full check-ins — inventory and SMART — before
    /// jitter. Six hours by default: often enough that a change is noticed the
    /// same working day, rare enough that the inventory history stays a history
    /// rather than a log.
    /// </summary>
    public int FullCheckInIntervalSeconds { get; set; } = 21_600;

    /// <summary>
    /// Header the server expects the agent key in. Matched to the server's own
    /// configuration; the value itself never lives here.
    /// </summary>
    public string AgentKeyHeaderName { get; set; } = "X-Mashura-Agent-Key";

    /// <summary>Header the server expects the machine identity in.</summary>
    public string MachineIdHeaderName { get; set; } = "X-Mashura-Machine-Id";

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
    /// <summary>Legacy configuration cannot widen the compiled monitoring capability ceiling.</summary>
    public string ExecutionMode { get; set; } = "DiagnosticOnly";

    /// <summary>Maintenance is available only in the explicit historical test build.</summary>
    public bool MaintenanceEnabled => CabinetPlatform.Contracts.Actions.MonitoringBoundary.LegacyMaintenanceTestBuild &&
        string.Equals(ExecutionMode, "Maintenance", StringComparison.Ordinal);

    /// <summary>Historical Demo is available only in the maintenance test build.</summary>
    public bool DemoEnabled => CabinetPlatform.Contracts.Actions.MonitoringBoundary.LegacyMaintenanceTestBuild &&
        string.Equals(ExecutionMode, "Demo", StringComparison.Ordinal);

    /// <summary>Compiled allowlist; never infer safety from a non-disruptive flag.</summary>
    public bool Permits(CabinetPlatform.Contracts.Actions.ActionName action) =>
        Enum.IsDefined(action) && (MaintenanceEnabled ||
            (DemoEnabled && action == CabinetPlatform.Contracts.Actions.ActionName.KillProcess) ||
            CabinetPlatform.Contracts.Actions.MonitoringBoundary.IsObservation(action));

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

    /// <summary>
    /// Image names this agent will end, without path or extension.
    /// </summary>
    /// <remarks>
    /// The agent's own copy, checked independently of the server's. Two lists
    /// that must both permit a name is not duplication for its own sake: it is
    /// what stops a compromised or simply buggy server from reaching a process
    /// this machine was never meant to expose. The critical-process deny-list
    /// is compiled in rather than configured, so a mistake here cannot widen it.
    /// </remarks>
    public List<string> ProcessAllowList { get; set; } = new();

    /// <summary>
    /// Applications this agent may stop and relaunch, mapped to the executable
    /// each one launches from on this machine.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The path lives here, in deployment configuration on the cabinet, and
    /// nowhere else. It is never supplied in a request, never sent by the
    /// server, and never echoed back: a path the server could choose would be a
    /// command line in everything but name, and would turn a restart action
    /// into arbitrary execution.
    /// </para>
    /// <para>
    /// An application named in a request but absent from this map is refused.
    /// The agent does not search for an executable and does not guess.
    /// </para>
    /// </remarks>
    public Dictionary<string, string> ApplicationInstallPaths { get; set; } = new();

    /// <summary>
    /// How long the agent waits for a process to exit after asking it to, in
    /// seconds, before reporting that it did not.
    /// </summary>
    [Range(1, 120)]
    public int ProcessExitTimeoutSeconds { get; set; } = 10;

    /// <summary>
    /// How long a network configuration change has to prove the cabinet can
    /// still reach the server before it is rolled back, in seconds.
    /// </summary>
    /// <remarks>
    /// Long enough for DHCP to settle and DNS to answer, short enough that a
    /// clinic is not without its cabinet while the agent waits. Without the
    /// revert, one wrong DNS server is a site visit.
    /// </remarks>
    [Range(10, 600)]
    public int NetworkConfirmationTimeoutSeconds { get; set; } = 60;

    /// <summary>
    /// File the previous network configuration is written to before a change is
    /// applied.
    /// </summary>
    /// <remarks>
    /// On disk rather than in memory, because the case that matters is the one
    /// where the machine restarts mid-change. A rollback held only in a running
    /// process is exactly the rollback that is not there when it is needed.
    /// </remarks>
    public string NetworkRollbackFileName { get; set; } = "network-rollback.json";
}

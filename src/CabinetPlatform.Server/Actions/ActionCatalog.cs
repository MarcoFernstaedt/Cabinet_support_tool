using System.Collections.Immutable;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;

namespace CabinetPlatform.Server.Actions;

/// <summary>
/// One immutable entry describing what an action is permitted to be.
/// </summary>
public sealed record ActionCatalogEntry
{
    /// <summary>The action this entry describes.</summary>
    public required ActionName Action { get; init; }

    /// <summary>Short label for the console.</summary>
    public required string DisplayName { get; init; }

    /// <summary>One sentence a support rep reads before choosing it.</summary>
    public required string Description { get; init; }

    /// <summary>Minimum role. Compared with <c>&gt;=</c> against the caller's resolved role.</summary>
    public required Role MinimumRole { get; init; }

    /// <summary>When true, a second, different user must approve before dispatch.</summary>
    public required bool RequiresApproval { get; init; }

    /// <summary>Interrupts clinic work if it runs at the wrong moment.</summary>
    public required bool IsDisruptive { get; init; }

    /// <summary>How long the agent is given to report an outcome.</summary>
    public required int TimeoutSeconds { get; init; }

    /// <summary>
    /// The complete set of parameter keys this action accepts. A request
    /// carrying anything else is rejected outright — an unknown key is never
    /// dropped quietly and never reaches an agent.
    /// </summary>
    public required ImmutableHashSet<string> AllowedParameterKeys { get; init; }

    /// <summary>Only runs inside the cabinet's own maintenance window.</summary>
    public required bool MaintenanceWindowOnly { get; init; }

    /// <summary>
    /// Refuses to run while someone is logged on. A cabinet dispensing a
    /// controlled substance is mid chain-of-custody; rebooting under it is not
    /// an inconvenience, it is a compliance incident. A <see langword="null"/>
    /// logged-on reading blocks it exactly as a <see langword="true"/> one
    /// does: "we could not tell" is never "nobody is there".
    /// </summary>
    public required bool BlockedIfUserLoggedOn { get; init; }

    /// <summary>
    /// Names another cabinet as its target, so the request carries a
    /// <c>targetCabinetId</c> and the server — never the console — resolves the
    /// address to probe.
    /// </summary>
    public bool TargetsAnotherCabinet { get; init; }

    /// <summary>
    /// Ports this action may probe. Empty for every action that does not probe
    /// one. The list is the server's, so a rep cannot reach a port the CUBEX
    /// stack does not use.
    /// </summary>
    public ImmutableHashSet<int> AllowedPorts { get; init; } = ImmutableHashSet<int>.Empty;

    /// <summary>
    /// Whether this action may be requested across several cabinets at once.
    /// </summary>
    public bool Batchable { get; init; }

    /// <summary>
    /// Cabinet count above which a batch needs a Supervisor regardless of
    /// <see cref="MinimumRole"/>. Approval requirements scale with blast
    /// radius: twenty cabinets is a different decision from one.
    /// </summary>
    public int BatchSupervisorThreshold { get; init; } = int.MaxValue;

    /// <summary>
    /// Cabinet count above which a Tier 2 may not approve the batch at all,
    /// whatever the action's single-cabinet rule says.
    /// </summary>
    public int BatchSupervisorOnlyThreshold { get; init; } = int.MaxValue;

    /// <summary>
    /// Largest batch the server will accept for this action. A batch above it
    /// is rejected, never truncated to fit.
    /// </summary>
    public int MaximumBatchSize { get; init; }
}

/// <summary>
/// The complete catalog of things this product can ask a cabinet to do.
/// </summary>
/// <remarks>
/// It lives in code, as static readonly data, precisely so that it cannot be
/// altered at runtime: not by an administrator, not by a Supervisor, not by
/// anyone with write access to the database. There is no endpoint anywhere in
/// this server that accepts a command string, a script body or SQL text, at
/// any role. If a requirement appears to need one, the requirement is wrong.
/// </remarks>
public static class ActionCatalog
{
    /// <summary>Parameter key naming the cabinet a diagnostic probe targets.</summary>
    public const string TargetCabinetIdKey = "targetCabinetId";

    /// <summary>Parameter key carrying the port a probe should open.</summary>
    public const string PortKey = "port";

    /// <summary>
    /// Parameter key by which the server hands the agent the address it
    /// resolved. The console never supplies it, and a request that arrives
    /// carrying it is rejected.
    /// </summary>
    public const string ResolvedTargetAddressKey = "resolvedTargetAddress";

    /// <summary>
    /// Parameter key by which a rep explicitly accepts a cross-site target.
    /// Absent means same-site only.
    /// </summary>
    public const string AllowCrossSiteKey = "allowCrossSite";

    private static readonly ImmutableDictionary<ActionName, ActionCatalogEntry> Entries =
        new[]
        {
            new ActionCatalogEntry
            {
                Action = ActionName.ScanForUpdates,
                DisplayName = "Scan for updates",
                Description = "Queries Windows Update for applicable patches. Installs nothing.",
                MinimumRole = Role.Tier1,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 600,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                BatchSupervisorThreshold = 50,
                MaximumBatchSize = 500,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.CollectDiagnosticBundle,
                DisplayName = "Collect diagnostic bundle",
                Description = "Gathers event logs and agent logs into an uploadable bundle.",
                MinimumRole = Role.Tier1,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 900,
                // The agent maps these to fixed collectors; neither is a path
                // or a command, and the agent resolves its own output location.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "includeEventLogs", "hoursOfHistory"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.FlushDnsCache,
                DisplayName = "Flush DNS cache",
                Description = "Clears the local resolver cache.",
                MinimumRole = Role.Tier2,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 60,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                BatchSupervisorThreshold = 25,
                MaximumBatchSize = 500,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.RenewDhcpLease,
                DisplayName = "Renew DHCP lease",
                Description = "Releases and renews the lease on the primary adapter.",
                MinimumRole = Role.Tier2,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 120,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                BatchSupervisorThreshold = 10,
                MaximumBatchSize = 200,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.RestartService,
                DisplayName = "Restart service",
                Description = "Restarts one service from the server-side service allow-list.",
                MinimumRole = Role.Tier2,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 180,
                // The value is additionally checked against ServiceAllowList —
                // an allow-listed key with a free-form value would just be
                // arbitrary execution wearing a different hat.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "serviceName"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                BatchSupervisorThreshold = 10,
                MaximumBatchSize = 200,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.StartService,
                DisplayName = "Start service",
                Description = "Starts one service from the server-side service allow-list.",
                MinimumRole = Role.Tier2,
                RequiresApproval = true,
                IsDisruptive = false,
                TimeoutSeconds = 180,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "serviceName"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                BatchSupervisorThreshold = 10,
                MaximumBatchSize = 200,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.StopService,
                DisplayName = "Stop service",
                Description = "Stops one service from the server-side service allow-list.",
                MinimumRole = Role.Tier2,
                RequiresApproval = true,
                IsDisruptive = true,
                TimeoutSeconds = 180,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "serviceName"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                BatchSupervisorThreshold = 5,
                BatchSupervisorOnlyThreshold = 20,
                MaximumBatchSize = 100,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.ScheduleUpdates,
                DisplayName = "Schedule updates",
                Description = "Schedules approved Windows updates for a maintenance window.",
                MinimumRole = Role.Tier2,
                RequiresApproval = true,
                IsDisruptive = false,
                TimeoutSeconds = 600,
                // scheduledForUtc arrives already converted from the cabinet's
                // local time by the console, and is re-checked here against the
                // cabinet's own zone.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "scheduledForUtc", "rebootIfRequired"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                BatchSupervisorThreshold = 25,
                MaximumBatchSize = 500,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.RebootMachine,
                DisplayName = "Reboot machine",
                Description = "Restarts the cabinet PC. Takes the cabinet offline for several minutes.",
                MinimumRole = Role.Tier2,
                RequiresApproval = true,
                IsDisruptive = true,
                TimeoutSeconds = 900,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "delaySeconds"),
                MaintenanceWindowOnly = true,
                BlockedIfUserLoggedOn = true,
                // Rebooting a whole site is the most dangerous thing this tool
                // can do. Any batch of it needs a Supervisor, and Tier 2 may
                // never approve one however small.
                Batchable = true,
                BatchSupervisorThreshold = 1,
                BatchSupervisorOnlyThreshold = 1,
                MaximumBatchSize = 50,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.CollectEventLogs,
                DisplayName = "View event logs",
                Description = "Fetches a window of Windows event log records for review.",
                MinimumRole = Role.Tier1,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 300,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "logName", "hoursOfHistory", "maxEntries", "minimumLevel"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.CollectProcessList,
                DisplayName = "View process list",
                Description = "Fetches the cabinet's current process list for review.",
                MinimumRole = Role.Tier1,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 120,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "maxEntries"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.PingCabinet,
                DisplayName = "Ping another cabinet",
                Description = "Pings another cabinet at this site, from this cabinet.",
                MinimumRole = Role.Tier1,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 60,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    TargetCabinetIdKey, AllowCrossSiteKey, ResolvedTargetAddressKey),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                TargetsAnotherCabinet = true,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.TestCabinetPort,
                DisplayName = "Test a port on another cabinet",
                Description = "Opens a TCP connection to a CUBEX port on another cabinet at this site.",
                MinimumRole = Role.Tier2,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 60,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    TargetCabinetIdKey, PortKey, AllowCrossSiteKey, ResolvedTargetAddressKey),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                TargetsAnotherCabinet = true,
                AllowedPorts = CubexPorts.All,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.TraceRouteToCabinet,
                DisplayName = "Trace route to another cabinet",
                Description = "Traces the network path to another cabinet at this site.",
                MinimumRole = Role.Tier2,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 180,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    TargetCabinetIdKey, AllowCrossSiteKey, ResolvedTargetAddressKey),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                TargetsAnotherCabinet = true,
                Batchable = false,
            },
        }.ToImmutableDictionary(x => x.Action);

    /// <summary>Every entry in the catalog.</summary>
    public static IReadOnlyCollection<ActionCatalogEntry> All { get; } = Entries.Values.ToImmutableArray();

    /// <summary>
    /// Resolves an action. Returns false for any value outside the enum — a
    /// client can put an arbitrary integer in a JSON body, and an unmapped
    /// integer must never fall through to a default entry.
    /// </summary>
    /// <param name="action">The action to resolve.</param>
    /// <param name="entry">The entry, when one exists.</param>
    public static bool TryGet(ActionName action, out ActionCatalogEntry entry) =>
        Entries.TryGetValue(action, out entry!);

    /// <summary>Resolves an action, throwing when it is not in the catalog.</summary>
    /// <param name="action">The action to resolve.</param>
    public static ActionCatalogEntry Get(ActionName action) =>
        Entries.TryGetValue(action, out ActionCatalogEntry? entry)
            ? entry
            : throw new ArgumentOutOfRangeException(nameof(action), action, "Action is not in the catalog.");
}

/// <summary>
/// The ports a cabinet-to-cabinet probe may open.
/// </summary>
/// <remarks>
/// Server-side and closed, for the same reason the service allow-list is: a
/// parameter whose value is unconstrained is a port scanner with extra steps.
/// These are the ports the CUBEX stack actually uses between a satellite and
/// its sync cabinet.
/// </remarks>
public static class CubexPorts
{
    /// <summary>The allow-listed ports.</summary>
    public static readonly ImmutableHashSet<int> All = ImmutableHashSet.Create(
        135,   // RPC endpoint mapper, used by the sync service
        443,   // HTTPS to the sync cabinet's local API
        445,   // SMB, used for the shared dispense record store
        1433,  // SQL Server, the sync cabinet's database
        3389,  // RDP, to confirm the host is up when nothing else answers
        5985,  // WinRM over HTTP
        5986); // WinRM over HTTPS
}

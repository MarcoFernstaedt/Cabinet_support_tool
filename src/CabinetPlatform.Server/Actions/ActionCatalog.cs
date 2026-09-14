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

    /// <summary>
    /// A reserved hardware-actuation action. Always refused, at every role and
    /// with every grant.
    /// </summary>
    /// <remarks>
    /// These entries exist so that the refusal is a real, exercised path with
    /// its own audit event, rather than a gap that a future change could fill
    /// by accident. No agent has an executor for any of them, and the server
    /// never dispatches one: the denial happens here, before anything else
    /// about the request is considered.
    /// </remarks>
    public bool IsReservedHardwareActuation { get; init; }

    /// <summary>
    /// Names another cabinet's <em>address or host name</em> rather than a
    /// cabinet, so the value is checked against
    /// <see cref="DiagnosticHostPolicy"/> instead of resolved from the fleet.
    /// </summary>
    public bool TargetsAHost { get; init; }
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
    /// <summary>Apply execution policy independently of user role and safety overrides.</summary>
    public static bool TryGet(ActionName action, Configuration.ActionOptions options, out ActionCatalogEntry entry)
    {
        entry = null!;
        return options.Permits(action) && TryGet(action, out entry);
    }

    /// <summary>The visible catalog is not itself an authorization boundary.</summary>
    public static IEnumerable<ActionCatalogEntry> Available(Configuration.ActionOptions options) =>
        All.Where(e => options.Permits(e.Action));

    /// <summary>Parameter key naming the cabinet a diagnostic probe targets.</summary>
    /// <remarks>
    /// These four are aliases of <see cref="ActionParameterKeys"/>, which is
    /// where every operand name in the product is spelled. They stay because
    /// the resolution code reads better for them; they must never be given a
    /// literal of their own, because the agent reads the same names from the
    /// same shared class and a second spelling is how the two sides drift.
    /// </remarks>
    public const string TargetCabinetIdKey = ActionParameterKeys.TargetCabinetId;

    /// <summary>Parameter key carrying the port a probe should open.</summary>
    public const string PortKey = ActionParameterKeys.Port;

    /// <summary>
    /// Parameter key by which the server hands the agent the address it
    /// resolved. The console never supplies it, and a request that arrives
    /// carrying it is rejected.
    /// </summary>
    public const string ResolvedTargetAddressKey = ActionParameterKeys.ResolvedTargetAddress;

    /// <summary>
    /// Parameter key by which a rep explicitly accepts a cross-site target.
    /// Absent means same-site only.
    /// </summary>
    public const string AllowCrossSiteKey = ActionParameterKeys.AllowCrossSite;

    /// <summary>
    /// Every action's minimum role for this build.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Tier 1 everywhere, deliberately and temporarily. Reps work any cabinet
    /// at any time — that is how the team already works over remote desktop,
    /// and pretending otherwise in the tool would only push work back onto
    /// remote desktop. The three roles remain on users, in tokens and in the
    /// audit trail, and the comparison below still runs on every request.
    /// </para>
    /// <para>
    /// The point of spelling it once here rather than repeating a literal
    /// thirty times is that tightening an action later is a one-line change to
    /// its entry, not a rewrite of authorization. The mechanism is exercised on
    /// every request today; only the value is permissive.
    /// </para>
    /// </remarks>
    private const Role EveryRep = Role.Tier1;

    private static readonly ImmutableDictionary<ActionName, ActionCatalogEntry> Entries =
        new[]
        {
            // ---------------------------------------------------------------
            // Windows Update
            // ---------------------------------------------------------------
            new ActionCatalogEntry
            {
                Action = ActionName.ScanForUpdates,
                DisplayName = "Scan for updates",
                Description = "Queries Windows Update for applicable patches. Installs nothing.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 600,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 500,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.ScheduleUpdates,
                DisplayName = "Schedule updates",
                Description =
                    "Schedules specific updates to install at a time given in the cabinet's own " +
                    "local clock.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = false,
                TimeoutSeconds = 600,
                // The install time is specified in the cabinet's own local
                // time, because that is what a rep and a clinic agree on. The
                // server converts it and adds scheduledForUtc, which is also
                // the only place the conversion can be checked: a local time
                // that does not exist because the zone springs forward that
                // morning is undetectable once converted.
                //
                // The update ids are specific. "Everything applicable" would
                // install whatever has become applicable between the rep
                // choosing and the machine acting, which is not what anybody
                // agreed to.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    ActionParameterKeys.ScheduledForLocal,
                    ActionParameterKeys.ScheduledForUtc,
                    ActionParameterKeys.UpdateIds,
                    ActionParameterKeys.RebootIfRequired),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 500,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.InstallUpdatesNow,
                DisplayName = "Install updates now",
                Description =
                    "Installs the named updates immediately. Takes the cabinet out of service " +
                    "while it runs and may restart it.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = true,
                TimeoutSeconds = 3600,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    ActionParameterKeys.UpdateIds,
                    ActionParameterKeys.RebootIfRequired),
                MaintenanceWindowOnly = false,
                // An install can restart the machine and always makes it
                // unresponsive for a while. A clinician mid-dispense is a
                // chain-of-custody problem, not an inconvenience, so an
                // unreadable logged-on flag blocks it exactly as a true one
                // does; only a Supervisor override with a stated reason passes.
                BlockedIfUserLoggedOn = true,
                Batchable = true,
                MaximumBatchSize = 50,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.CancelScheduledUpdates,
                DisplayName = "Cancel scheduled updates",
                Description = "Withdraws a pending scheduled install. Installs and removes nothing.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 120,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 500,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.GetScheduledUpdates,
                DisplayName = "View scheduled updates",
                Description = "Reads what the cabinet has scheduled to install, and when in its own time.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 120,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },

            // ---------------------------------------------------------------
            // Diagnostics that collect and change nothing
            // ---------------------------------------------------------------
            new ActionCatalogEntry
            {
                Action = ActionName.CollectDiagnosticBundle,
                DisplayName = "Collect diagnostic bundle",
                Description = "Gathers event logs and agent logs into an uploadable bundle.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 900,
                // The agent maps these to fixed collectors; neither is a path
                // or a command, and the agent resolves its own output location.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    ActionParameterKeys.IncludeEventLogs, ActionParameterKeys.HoursOfHistory),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.CollectEventLogs,
                DisplayName = "View event logs",
                Description = "Fetches a window of Windows event log records for review.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 300,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    ActionParameterKeys.LogName,
                    ActionParameterKeys.HoursOfHistory,
                    ActionParameterKeys.MaxEntries,
                    ActionParameterKeys.MinimumLevel),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.RunEventLogView,
                DisplayName = "Run an event log view",
                Description =
                    "Runs one saved, named event log filter on the cabinet and returns what matched.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 300,
                // The caller names a view. The definition key is filled in by
                // the server after it has read that view from the database, and
                // a request that arrives already carrying one is refused: the
                // whole point is that no expression a user wrote reaches the
                // agent's event log query.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    ActionParameterKeys.EventLogViewId,
                    ActionParameterKeys.EventLogViewDefinition,
                    ActionParameterKeys.HoursOfHistory),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.GetProcessList,
                DisplayName = "View process list",
                Description = "Reads the cabinet's current process list, outside the check-in cadence.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 120,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, ActionParameterKeys.MaxEntries),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },

            // ---------------------------------------------------------------
            // Process management
            // ---------------------------------------------------------------
            new ActionCatalogEntry
            {
                Action = ActionName.KillProcess,
                DisplayName = "End a process",
                Description =
                    "Ends only the selected process after matching its observed PID, name, exact creation time and image path.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = false,
                TimeoutSeconds = 120,
                // All four operands are mandatory. Image path is comparison-only,
                // never a launch target. The agent retains one handle through the effect.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    ActionParameterKeys.ProcessId,
                    ActionParameterKeys.ExpectedProcessName,
                    ActionParameterKeys.ExpectedCreationTimeFileTime,
                    ActionParameterKeys.ExpectedExecutablePath),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.KillProcessByName,
                DisplayName = "End processes by name",
                Description = "Ends every process running under one allow-listed image name.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = false,
                TimeoutSeconds = 120,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, ActionParameterKeys.ProcessName),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 100,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.RestartApplication,
                DisplayName = "Restart an application",
                Description =
                    "Stops an allow-listed application and starts it again from its registered " +
                    "install path on that machine.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = false,
                TimeoutSeconds = 300,
                // Only the application's name. The executable comes from the
                // agent's own registration for that name; a path parameter
                // would be a command line wearing a different hat.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, ActionParameterKeys.ApplicationName),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 100,
            },

            // ---------------------------------------------------------------
            // Services
            // ---------------------------------------------------------------
            new ActionCatalogEntry
            {
                Action = ActionName.RestartService,
                DisplayName = "Restart service",
                Description = "Restarts one service from the server-side service allow-list.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 180,
                // The value is additionally checked against ServiceAllowList —
                // an allow-listed key with a free-form value would just be
                // arbitrary execution wearing a different hat.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, ActionParameterKeys.ServiceName),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 200,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.StartService,
                DisplayName = "Start service",
                Description = "Starts one service from the server-side service allow-list.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = false,
                TimeoutSeconds = 180,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, ActionParameterKeys.ServiceName),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 200,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.StopService,
                DisplayName = "Stop service",
                Description = "Stops one service from the server-side service allow-list.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = true,
                TimeoutSeconds = 180,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, ActionParameterKeys.ServiceName),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 100,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.SetServiceStartType,
                DisplayName = "Set service start type",
                Description =
                    "Changes whether an allow-listed service starts at boot, on demand, or not at all.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = false,
                TimeoutSeconds = 120,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    ActionParameterKeys.ServiceName,
                    ActionParameterKeys.StartType),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 100,
            },

            // ---------------------------------------------------------------
            // Machine state
            // ---------------------------------------------------------------
            new ActionCatalogEntry
            {
                Action = ActionName.RebootMachine,
                DisplayName = "Reboot machine",
                Description = "Restarts the cabinet PC. Takes the cabinet offline for several minutes.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = true,
                TimeoutSeconds = 900,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, ActionParameterKeys.DelaySeconds),
                MaintenanceWindowOnly = true,
                BlockedIfUserLoggedOn = true,
                // Rebooting a whole site is the widest thing this tool can do,
                // so the batch is capped tightly even though approval no longer
                // scales with size in this build.
                Batchable = true,
                MaximumBatchSize = 50,
            },

            // ---------------------------------------------------------------
            // Network: read-only probes
            // ---------------------------------------------------------------
            new ActionCatalogEntry
            {
                Action = ActionName.FlushDnsCache,
                DisplayName = "Flush DNS cache",
                Description = "Clears the local resolver cache.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 60,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 500,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.RenewDhcpLease,
                DisplayName = "Renew DHCP lease",
                Description = "Releases and renews the lease on the primary adapter.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 120,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = true,
                MaximumBatchSize = 200,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.PingHost,
                DisplayName = "Ping a host",
                Description = "Pings a named host or address from this cabinet.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 60,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, ActionParameterKeys.TargetHost),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                TargetsAHost = true,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.TraceRoute,
                DisplayName = "Trace route to a host",
                Description = "Traces the network path from this cabinet to a named host or address.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 180,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, ActionParameterKeys.TargetHost),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                TargetsAHost = true,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.TestPortConnectivity,
                DisplayName = "Test a port on a host",
                Description = "Opens a TCP connection to a CUBEX port on a named host or address.",
                MinimumRole = EveryRep,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 60,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    ActionParameterKeys.TargetHost, PortKey),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                TargetsAHost = true,
                AllowedPorts = CubexPorts.All,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.PingCabinet,
                DisplayName = "Ping another cabinet",
                Description = "Pings another cabinet at this site, from this cabinet.",
                MinimumRole = EveryRep,
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
                MinimumRole = EveryRep,
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
                MinimumRole = EveryRep,
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

            // ---------------------------------------------------------------
            // Network: configuration changes, all under confirm-or-revert
            // ---------------------------------------------------------------
            // Each of these can strand a cabinet. The agent writes the previous
            // configuration to disk, applies the new one, and puts the old one
            // back unless it can reach this server within a timeout — so the
            // worst case is a short outage rather than a site visit. They are
            // marked disruptive and need a second person because a wrong answer
            // costs a clinic its cabinet until somebody drives there.
            new ActionCatalogEntry
            {
                Action = ActionName.SetDnsServers,
                DisplayName = "Set DNS servers",
                Description =
                    "Replaces an adapter's DNS servers, and puts the old ones back if the cabinet " +
                    "then cannot reach this server.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = true,
                TimeoutSeconds = 300,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    ActionParameterKeys.AdapterId,
                    ActionParameterKeys.DnsServers),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.SetStaticIpAddress,
                DisplayName = "Set a static address",
                Description =
                    "Gives an adapter a static address, and puts the old configuration back if the " +
                    "cabinet then cannot reach this server.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = true,
                TimeoutSeconds = 300,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase,
                    ActionParameterKeys.AdapterId,
                    ActionParameterKeys.IpAddress,
                    ActionParameterKeys.SubnetMask,
                    ActionParameterKeys.DefaultGateway),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },
            new ActionCatalogEntry
            {
                Action = ActionName.SetAdapterToDhcp,
                DisplayName = "Return an adapter to DHCP",
                Description =
                    "Returns an adapter to DHCP, and puts the old configuration back if the cabinet " +
                    "then cannot reach this server.",
                MinimumRole = EveryRep,
                RequiresApproval = true,
                IsDisruptive = true,
                TimeoutSeconds = 300,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, ActionParameterKeys.AdapterId),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false,
                Batchable = false,
            },

            // ---------------------------------------------------------------
            // Reserved: hardware actuation. Always denied.
            // ---------------------------------------------------------------
            // These three exist so the refusal is a real path with a real audit
            // event rather than a gap. No agent has an executor for any of them,
            // the server refuses them before it considers anything else about
            // the request, and no role or grant changes that. Do not add an
            // executor here; actuating a lock on a cabinet holding controlled
            // substances is a separate design with its own safety case and its
            // own on-site confirmation.
            ReservedActuation(
                ActionName.OpenDrawer,
                "Open a drawer",
                "Reserved. This platform does not actuate cabinet hardware."),
            ReservedActuation(
                ActionName.UnlockLock,
                "Release a lock",
                "Reserved. This platform does not actuate cabinet hardware."),
            ReservedActuation(
                ActionName.OpenCubie,
                "Open a cubie",
                "Reserved. This platform does not actuate cabinet hardware."),
        }.ToImmutableDictionary(x => x.Action);

    /// <summary>
    /// Builds one reserved actuation entry.
    /// </summary>
    /// <remarks>
    /// Every field is set to the most restrictive value it can take, so that
    /// even a future change that accidentally routed one of these past the
    /// reserved check would find an action nobody can request: no parameters,
    /// no batching, maintenance window only, and blocked while anybody is at
    /// the cabinet.
    /// </remarks>
    /// <param name="action">The reserved action.</param>
    /// <param name="displayName">Label, so the refusal names something a person recognises.</param>
    /// <param name="description">One sentence saying why it is refused.</param>
    private static ActionCatalogEntry ReservedActuation(
        ActionName action, string displayName, string description) => new()
    {
        Action = action,
        DisplayName = displayName,
        Description = description,
        MinimumRole = Role.Supervisor,
        RequiresApproval = true,
        IsDisruptive = true,
        TimeoutSeconds = 60,
        AllowedParameterKeys = ImmutableHashSet<string>.Empty,
        MaintenanceWindowOnly = true,
        BlockedIfUserLoggedOn = true,
        Batchable = false,
        IsReservedHardwareActuation = true,
    };

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

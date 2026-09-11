using System.Collections.Immutable;
using Mashura.CabinetSupport.Contracts.Enums;

namespace Mashura.CabinetSupport.Server.Actions;

/// <summary>
/// One immutable entry describing what an action is permitted to be.
/// </summary>
public sealed record ActionCatalogEntry
{
    public required CabinetActionType Action { get; init; }
    public required string DisplayName { get; init; }
    public required string Description { get; init; }

    /// <summary>Minimum role. Compared with <c>&gt;=</c> against the caller's resolved role.</summary>
    public required UserRole MinimumRole { get; init; }

    /// <summary>When true, a second, different user must approve before dispatch.</summary>
    public required bool RequiresApproval { get; init; }

    /// <summary>Interrupts clinic work if it runs at the wrong moment.</summary>
    public required bool IsDisruptive { get; init; }

    public required int TimeoutSeconds { get; init; }

    /// <summary>
    /// The complete set of parameter keys this action accepts. A request
    /// carrying anything else is rejected outright — an unknown key is never
    /// dropped quietly and never reaches an agent.
    /// </summary>
    public required ImmutableHashSet<string> AllowedParameterKeys { get; init; }

    public required bool MaintenanceWindowOnly { get; init; }

    /// <summary>
    /// Refuses to run while someone is logged on. A cabinet dispensing a
    /// controlled substance is mid chain-of-custody; rebooting under it is not
    /// an inconvenience, it is a compliance incident.
    /// </summary>
    public required bool BlockedIfUserLoggedOn { get; init; }
}

/// <summary>
/// The complete catalogue of things this product can ask a cabinet to do.
///
/// It lives in code, as static readonly data, precisely so that it cannot be
/// altered at runtime: not by an administrator, not by a Supervisor, not by
/// anyone with write access to the database. There is no endpoint anywhere in
/// this server that accepts a command string, a script body or SQL text, at
/// any role. If a requirement appears to need one, the requirement is wrong.
/// </summary>
public static class ActionCatalog
{
    private static readonly ImmutableDictionary<CabinetActionType, ActionCatalogEntry> Entries =
        new[]
        {
            new ActionCatalogEntry
            {
                Action = CabinetActionType.ScanForUpdates,
                DisplayName = "Scan for updates",
                Description = "Queries Windows Update for applicable patches. Installs nothing.",
                MinimumRole = UserRole.Tier1,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 600,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false
            },
            new ActionCatalogEntry
            {
                Action = CabinetActionType.CollectDiagnosticBundle,
                DisplayName = "Collect diagnostic bundle",
                Description = "Gathers event logs and agent logs into an uploadable bundle.",
                MinimumRole = UserRole.Tier1,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 900,
                // The agent maps these to fixed collectors; neither is a path
                // or a command, and the agent resolves its own output location.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "includeEventLogs", "hoursOfHistory"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false
            },
            new ActionCatalogEntry
            {
                Action = CabinetActionType.FlushDnsCache,
                DisplayName = "Flush DNS cache",
                Description = "Clears the local resolver cache.",
                MinimumRole = UserRole.Tier2,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 60,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false
            },
            new ActionCatalogEntry
            {
                Action = CabinetActionType.RenewDhcpLease,
                DisplayName = "Renew DHCP lease",
                Description = "Releases and renews the lease on the primary adapter.",
                MinimumRole = UserRole.Tier2,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 120,
                AllowedParameterKeys = ImmutableHashSet<string>.Empty,
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false
            },
            new ActionCatalogEntry
            {
                Action = CabinetActionType.RestartService,
                DisplayName = "Restart service",
                Description = "Restarts one service from the server-side service allow-list.",
                MinimumRole = UserRole.Tier2,
                RequiresApproval = false,
                IsDisruptive = false,
                TimeoutSeconds = 180,
                // The value is additionally checked against ServiceAllowList —
                // an allow-listed key with a free-form value would just be
                // arbitrary execution wearing a different hat.
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "serviceName"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false
            },
            new ActionCatalogEntry
            {
                Action = CabinetActionType.StartService,
                DisplayName = "Start service",
                Description = "Starts one service from the server-side service allow-list.",
                MinimumRole = UserRole.Tier2,
                RequiresApproval = true,
                IsDisruptive = false,
                TimeoutSeconds = 180,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "serviceName"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false
            },
            new ActionCatalogEntry
            {
                Action = CabinetActionType.StopService,
                DisplayName = "Stop service",
                Description = "Stops one service from the server-side service allow-list.",
                MinimumRole = UserRole.Tier2,
                RequiresApproval = true,
                IsDisruptive = true,
                TimeoutSeconds = 180,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "serviceName"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false
            },
            new ActionCatalogEntry
            {
                Action = CabinetActionType.ScheduleUpdates,
                DisplayName = "Schedule updates",
                Description = "Schedules approved Windows updates for a maintenance window.",
                MinimumRole = UserRole.Tier2,
                RequiresApproval = true,
                IsDisruptive = false,
                TimeoutSeconds = 600,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "scheduledForUtc", "rebootIfRequired"),
                MaintenanceWindowOnly = false,
                BlockedIfUserLoggedOn = false
            },
            new ActionCatalogEntry
            {
                Action = CabinetActionType.RebootMachine,
                DisplayName = "Reboot machine",
                Description = "Restarts the cabinet PC. Takes the cabinet offline for several minutes.",
                MinimumRole = UserRole.Tier2,
                RequiresApproval = true,
                IsDisruptive = true,
                TimeoutSeconds = 900,
                AllowedParameterKeys = ImmutableHashSet.Create(
                    StringComparer.OrdinalIgnoreCase, "delaySeconds"),
                MaintenanceWindowOnly = true,
                BlockedIfUserLoggedOn = true
            }
        }.ToImmutableDictionary(x => x.Action);

    public static IReadOnlyCollection<ActionCatalogEntry> All { get; } =
        Entries.Values.ToImmutableArray();

    /// <summary>
    /// Resolves an action. Returns false for any value outside the enum — a
    /// client can put an arbitrary integer in a JSON body, and an unmapped
    /// integer must never fall through to a default entry.
    /// </summary>
    public static bool TryGet(CabinetActionType action, out ActionCatalogEntry entry) =>
        Entries.TryGetValue(action, out entry!);

    public static ActionCatalogEntry Get(CabinetActionType action) =>
        Entries.TryGetValue(action, out var entry)
            ? entry
            : throw new ArgumentOutOfRangeException(nameof(action), action, "Action is not in the catalogue.");
}

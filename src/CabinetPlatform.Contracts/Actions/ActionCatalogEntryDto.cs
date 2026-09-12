using CabinetPlatform.Contracts.Auth;

namespace CabinetPlatform.Contracts.Actions;

/// <summary>
/// The client-visible description of one catalog entry.
/// </summary>
/// <remarks>
/// The console uses it to label and grey out buttons; the server never reads it
/// back. The authoritative catalog lives in server code and cannot be edited at
/// runtime, so nothing a client returns here can widen what an action is
/// allowed to do.
/// </remarks>
public sealed record ActionCatalogEntryDto
{
    /// <summary>The action this entry describes.</summary>
    public required ActionName Action { get; init; }

    /// <summary>Short label for a button or list row.</summary>
    public required string DisplayName { get; init; }

    /// <summary>One sentence a support rep reads before choosing the action.</summary>
    public required string Description { get; init; }

    /// <summary>Lowest role permitted to request it.</summary>
    public required Role MinimumRole { get; init; }

    /// <summary>Whether a second person must approve before dispatch.</summary>
    public required bool RequiresApproval { get; init; }

    /// <summary>Whether the action interrupts the cabinet's normal operation.</summary>
    public required bool IsDisruptive { get; init; }

    /// <summary>How long the agent is given to report an outcome.</summary>
    public required int TimeoutSeconds { get; init; }

    /// <summary>
    /// Parameter keys this action accepts. A key outside this list is a
    /// rejection, never a silently dropped field.
    /// </summary>
    public IReadOnlyList<string> AllowedParameterKeys { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Ports <see cref="ActionName.TestCabinetPort"/> may probe, drawn from the
    /// server's allow-list of ports the CUBEX stack actually uses. Empty for
    /// every other action.
    /// </summary>
    public IReadOnlyList<int> AllowedPorts { get; init; } = Array.Empty<int>();

    /// <summary>Whether the action may only run inside the cabinet's maintenance window.</summary>
    public required bool MaintenanceWindowOnly { get; init; }

    /// <summary>
    /// Whether the action is blocked while somebody is signed in at the
    /// cabinet. A <see langword="null"/> logged-on reading blocks it exactly as
    /// a <see langword="true"/> one does.
    /// </summary>
    public required bool BlockedIfUserLoggedOn { get; init; }

    /// <summary>
    /// Whether the action names another cabinet as its target, so the console
    /// must offer a cabinet picker rather than a free-text field.
    /// </summary>
    public required bool TargetsAnotherCabinet { get; init; }

    /// <summary>
    /// Number of cabinets above which a batch of this action needs a
    /// Supervisor regardless of <see cref="MinimumRole"/>, or
    /// <see langword="null"/> when the action may not be batched at all.
    /// </summary>
    public int? BatchSupervisorThreshold { get; init; }

    /// <summary>
    /// Whether this action may be requested across several cabinets at once.
    /// </summary>
    /// <remarks>
    /// Not every action makes sense in bulk, and the ones that do not are the
    /// ones where a mistake is widest. The console offers the batch path only
    /// for actions marked here; the server checks again and refuses a batch of
    /// anything else.
    /// </remarks>
    public required bool Batchable { get; init; }

    /// <summary>
    /// Largest batch of this action the server will accept. A batch above it is
    /// rejected outright, never truncated to fit.
    /// </summary>
    public int? MaximumBatchSize { get; init; }
}

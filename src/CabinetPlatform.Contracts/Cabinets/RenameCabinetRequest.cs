using System.ComponentModel.DataAnnotations;

namespace CabinetPlatform.Contracts.Cabinets;

/// <summary>Changes an operator label, never device identity or Windows hostname.</summary>
public sealed record RenameCabinetRequest
{
    /// <summary>New nonempty friendly label.</summary>
    [Required, MaxLength(120)]
    public required string FriendlyName { get; init; }

    /// <summary>Why the label is changing.</summary>
    [Required, MaxLength(2000)]
    public required string Reason { get; init; }
}

using System.ComponentModel.DataAnnotations;

namespace CabinetPlatform.Contracts.Cabinets;

/// <summary>Withdraws a cabinet from service without deleting its history.</summary>
public sealed record RetireCabinetRequest
{
    /// <summary>Required explanation retained in the named supervisor audit.</summary>
    [Required, MaxLength(2000)]
    public required string Reason { get; init; }
}

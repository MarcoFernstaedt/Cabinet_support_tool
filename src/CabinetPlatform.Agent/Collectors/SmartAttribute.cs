namespace CabinetPlatform.Agent.Collectors;

/// <summary>One decoded S.M.A.R.T. attribute record.</summary>
public sealed record SmartAttribute
{
    /// <summary>Vendor-independent attribute id, for example 0x05.</summary>
    public required byte Id { get; init; }

    /// <summary>Normalised current value, typically 1-253, higher is better.</summary>
    public required byte Current { get; init; }

    /// <summary>Worst normalised value seen by the drive.</summary>
    public required byte Worst { get; init; }

    /// <summary>Threshold-crossing and pre-fail status flags.</summary>
    public required ushort Flags { get; init; }

    /// <summary>The 48-bit vendor-specific raw value.</summary>
    public required long Raw { get; init; }
}

/// <summary>The attribute ids the agent interprets.</summary>
public static class SmartAttributeIds
{
    public const byte ReallocatedSectorCount = 0x05;
    public const byte PowerOnHours = 0x09;
    public const byte TemperatureCelsius = 0xC2;
    public const byte CurrentPendingSectorCount = 0xC5;
    public const byte UncorrectableSectorCount = 0xC6;
}

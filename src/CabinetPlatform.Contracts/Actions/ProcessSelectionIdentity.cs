namespace CabinetPlatform.Contracts.Actions;

/// <summary>Identity captured when a process is selected, never a launch command.</summary>
public sealed record ProcessSelectionIdentity
{
    /// <summary>Operating system process identifier.</summary>
    public required int ProcessId { get; init; }
    /// <summary>Observed image name without path.</summary>
    public required string ProcessName { get; init; }

    /// <summary>Exact Windows creation FILETIME, not a rounded display timestamp.</summary>
    [System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)]
    public required long CreationTimeFileTime { get; init; }

    /// <summary>Full image path as observed by Windows. Used only for comparison.</summary>
    public required string ExecutablePath { get; init; }

    /// <summary>Validates a bounded Windows full image path for comparison, never for execution.</summary>
    public static bool IsValidExecutablePath(string? path) =>
        !string.IsNullOrWhiteSpace(path) && path.Length <= 32767 && !path.Any(char.IsControl) &&
        ((path.Length > 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\') ||
         (path.Length > 4 && path.StartsWith(@"\\", StringComparison.Ordinal)));

}

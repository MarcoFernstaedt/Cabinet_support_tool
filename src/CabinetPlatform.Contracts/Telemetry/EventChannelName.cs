namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>Conservative local Windows channel identifier, never a file, host or XPath.</summary>
public static class EventChannelName
{
    /// <summary>Checks without trimming or rewriting the identifier.</summary>
    public static bool IsValid(string? name)
        => !string.IsNullOrWhiteSpace(name) && name.Length <= 512 && name == name.Trim()
           && !name.EndsWith(".evtx", StringComparison.OrdinalIgnoreCase)
           && name.Split('/').All(part => part.Length > 0 && part is not "." and not "..")
           && name.All(c => char.IsLetterOrDigit(c) || c is ' ' or '-' or '_' or '.' or '/' or '+');
}

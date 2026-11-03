namespace Cabinet.Agent.Core.Helpers;

/// <summary>
/// The data fields of Kernel-Power 41 ("the system has rebooted without cleanly shutting down first") that say why: BugcheckCode is
/// non-zero after a blue screen, PowerButtonTimestamp when the power button was held (decision-log D19). Only these four names are
/// ever kept, and only plain decimal or 0x-hex numbers, so this never becomes a way to send other event data.
/// </summary>
public static class KernelPowerFields
{
    public const string Provider = "Microsoft-Windows-Kernel-Power";
    public const int EventId = 41;
    public static readonly IReadOnlyList<string> Names = ["BugcheckCode", "BugcheckParameter1", "PowerButtonTimestamp", "SleepInProgress"];

    /// <summary>Whether an entry is Kernel-Power 41, whose fields are worth reading.</summary>
    public static bool Applies(string? provider, int eventId) =>
        eventId == EventId && string.Equals(provider, Provider, StringComparison.OrdinalIgnoreCase);

    /// <summary>The kept fields from an event's data, or null when none is present and a number. The first of a repeated name wins.</summary>
    public static IReadOnlyDictionary<string, string>? Pick(IEnumerable<KeyValuePair<string, string?>> data)
    {
        var picked = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (rawName, rawValue) in data)
        {
            string? name = Names.FirstOrDefault(n => string.Equals(n, rawName, StringComparison.OrdinalIgnoreCase));
            if (name is null || picked.ContainsKey(name)) continue;
            string value = (rawValue ?? "").Trim();
            if (IsNumber(value)) picked[name] = value;
        }
        return picked.Count == 0 ? null : picked;
    }

    /// <summary>
    /// Decimal of 1 to 20 digits, or a lower-case 0x and 1 to 16 hex digits; ASCII only. Exactly the eventlog.query contract's pattern, so the
    /// agent never sends a value its own outbound check would refuse (an upper-case 0X would fail the whole query result; #150 review).
    /// </summary>
    public static bool IsNumber(string v)
    {
        if (v.StartsWith("0x", StringComparison.Ordinal))
        {
            string hex = v[2..];
            return hex.Length is >= 1 and <= 16 && hex.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f') or (>= 'A' and <= 'F'));
        }
        return v.Length is >= 1 and <= 20 && v.All(c => c is >= '0' and <= '9');
    }
}

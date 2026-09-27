using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Presentation;

/// <summary>Display guard, not a server outage or metric-health detection rule.</summary>
public static class MonitoringFreshness
{
    // Existing fleet worklist age. This is a console snapshot warning only;
    // heartbeat cadence and production alert thresholds remain server concerns.
    public static readonly TimeSpan StaleAfter = TimeSpan.FromMinutes(30);

    public static StatusPresentation ForLastSeen(DateTimeOffset? seen, DateTimeOffset now, string subject = "last seen")
    {
        if (seen is null || seen == DateTimeOffset.MinValue)
            return new($"Unknown: {subject} not reported", "?", StatusSeverity.Unknown);
        if (seen > now)
            return new($"Unknown: {subject} is in the future; check clocks", "?", StatusSeverity.Unknown);
        if (now - seen >= StaleAfter)
            return new($"Stale: {subject} at least 30 minutes ago", "▲", StatusSeverity.Warning);
        return new("Recent check-in; metric freshness unknown", "○", StatusSeverity.Neutral);
    }

    public static StatusPresentation ForCabinet(CabinetHealthStatus health, DateTimeOffset? seen, DateTimeOffset now)
    {
        var freshness = ForLastSeen(seen, now);
        if (health == CabinetHealthStatus.Offline)
            return new("Disconnected (server reports offline)", "●", StatusSeverity.Critical);
        if (freshness.Severity != StatusSeverity.Neutral) return PreserveProblem(freshness, health);
        return Historical(StatusPresentation.ForCabinet(health));
    }

    public static StatusPresentation PreserveProblem(StatusPresentation freshness, CabinetHealthStatus health)
    {
        if (health is not (CabinetHealthStatus.Warning or CabinetHealthStatus.Critical)) return freshness;
        var reported = StatusPresentation.ForCabinet(health);
        return new($"{freshness.Label}; last reported {reported.Label}", reported.Glyph, reported.Severity);
    }

    public static StatusPresentation Historical(StatusPresentation status) => new(
        $"Last reported: {status.Label}; current state unverified", status.Glyph,
        status.Severity == StatusSeverity.Good ? StatusSeverity.Neutral : status.Severity);

    public static string LastSeen(DateTimeOffset? seen) =>
        "Last seen: " + (seen is null || seen == DateTimeOffset.MinValue ? "Unknown (not reported)" : Format.LocalTime(seen));
}

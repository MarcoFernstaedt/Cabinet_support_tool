using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Server.Services;

/// <summary>Deterministic rule v1. No inference of firewall, sync application or whole-site health.</summary>
public static class ConnectivityClassifier
{
    public const int FailureThreshold = 3;

    public static bool IsValid(ConnectivitySummary s, DateTimeOffset now)
    {
        if (s.Id == Guid.Empty || s.ConfigurationId == Guid.Empty || s.SourceCabinetId == Guid.Empty || s.TargetCabinetId == Guid.Empty ||
            s.FirstObservedUtc < now.AddDays(-14) || s.LastObservedUtc > now ||
            s.LastObservedUtc - s.FirstObservedUtc < TimeSpan.FromSeconds(118) ||
            s.LastObservedUtc - s.FirstObservedUtc > TimeSpan.FromSeconds(150) ||
            s.SuccessCount is < 0 or > 3 || s.FailureCount is < 0 or > 3 || s.ErrorCount is < 0 or > 3 ||
            s.SuccessCount + s.FailureCount + s.ErrorCount != 3 ||
            !ValidTime(s.LastSuccessUtc, s.SuccessCount, s) || !ValidTime(s.LastFailureUtc, s.FailureCount, s)) return false;
        // There are only 27 possible ternary intervals. Match a possible aggregate
        // rather than accepting contradictory leading/trailing counters from wire JSON.
        for (var encoded = 0; encoded < 27; encoded++)
        {
            int n = encoded, successes = 0, failures = 0, leading = 0, trailing = 0, longest = 0;
            int lastSuccess = -1, lastFailure = -1;
            for (var i = 0; i < 3; i++)
            {
                int value = n % 3;
                n /= 3;
                if (value == 0) { successes++; lastSuccess = i; }
                if (value == 1)
                {
                    failures++;
                    lastFailure = i;
                    trailing++;
                    if (leading == i) leading++;
                    longest = Math.Max(longest, trailing);
                }
                else trailing = 0;
            }
            if (s.SuccessCount == successes && s.FailureCount == failures && s.LeadingFailures == leading &&
                s.TrailingFailures == trailing && s.MaximumFailureRun == longest &&
                MatchesPosition(s.LastSuccessUtc, lastSuccess, s) && MatchesPosition(s.LastFailureUtc, lastFailure, s)) return true;
        }
        return false;
    }

    private static bool MatchesPosition(DateTimeOffset? timestamp, int position, ConnectivitySummary summary) => position switch
    {
        -1 => timestamp is null,
        0 => timestamp == summary.FirstObservedUtc,
        2 => timestamp == summary.LastObservedUtc,
        _ => timestamp - summary.FirstObservedUtc >= TimeSpan.FromSeconds(58) &&
             timestamp - summary.FirstObservedUtc <= TimeSpan.FromSeconds(75) &&
             summary.LastObservedUtc - timestamp >= TimeSpan.FromSeconds(58) &&
             summary.LastObservedUtc - timestamp <= TimeSpan.FromSeconds(75)
    };

    private static bool ValidTime(DateTimeOffset? value, int count, ConnectivitySummary s) =>
        count == 0 ? value is null : value >= s.FirstObservedUtc && value <= s.LastObservedUtc;

    public static ConnectivityLinkState Apply(ConnectivityLinkState previous, ConnectivitySummary s, DateTimeOffset received)
    {
        if (previous.ObservedUtc >= s.LastObservedUtc) return previous;
        bool contiguous = previous.ObservedUtc is { } last &&
            s.FirstObservedUtc - last >= TimeSpan.FromSeconds(58) && s.FirstObservedUtc - last <= TimeSpan.FromSeconds(90);
        int prefix = contiguous ? previous.ConsecutiveFailures : 0;
        int trailing = s.TrailingFailures == 3 ? Math.Min(1000000, prefix + 3) : s.TrailingFailures;
        bool triggered = s.MaximumFailureRun >= FailureThreshold || prefix + s.LeadingFailures >= FailureThreshold;
        bool open = previous.IncidentOpen || triggered;
        var incidentObserved = previous.IncidentObservedUtc;
        var incidentReceived = previous.IncidentReceivedUtc;
        var recovered = previous.RecoveredObservedUtc;
        if (triggered && !previous.IncidentOpen)
        {
            // A prefix of two failures reaches threshold at the first sample.
            // LastFailureUtc may instead describe a new run after a reply.
            incidentObserved = prefix >= 2 && s.LeadingFailures > 0
                ? s.FirstObservedUtc
                // With one prior failure and three new failures the threshold is
                // the middle sample. Its timestamp is absent from this aggregate.
                // Do not substitute a later sample or assume exact timer cadence.
                : prefix == 1 && s.LeadingFailures == 3 ? null : s.LastFailureUtc;
            incidentReceived = received;
            recovered = null;
        }
        // An error/gap is unknown, never an all-clear. Only an actual reply
        // after the run clears an incident. Three-sample intervals make ordering unambiguous.
        if (open && s.SuccessCount > 0 && trailing < FailureThreshold)
        {
            open = false;
            recovered = s.LastSuccessUtc;
        }
        string condition = trailing >= FailureThreshold ? "Unreachable" : s.TrailingFailures > 0 ? "Degraded" :
            s.LastSuccessUtc == s.LastObservedUtc ? "Reachable" : "Unknown";
        return previous with
        {
            ObservedUtc = s.LastObservedUtc, ReceivedUtc = received,
            LastSuccessUtc = s.LastSuccessUtc ?? previous.LastSuccessUtc,
            ConsecutiveFailures = trailing, Condition = condition, IncidentOpen = open,
            IncidentObservedUtc = incidentObserved, IncidentReceivedUtc = incidentReceived,
            RecoveredObservedUtc = recovered
        };
    }
}

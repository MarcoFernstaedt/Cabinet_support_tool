using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Services;

namespace CabinetPlatform.Server.Tests;

public sealed class ConnectivityClassifierTests
{
    [Fact]
    public void Contradictory_success_timestamps_cannot_turn_a_failed_final_probe_green()
    {
        var now = DateTimeOffset.UtcNow;
        var s = Summary("SFF", now.AddMinutes(-2));
        Assert.True(ConnectivityClassifier.IsValid(s, now));
        Assert.False(ConnectivityClassifier.IsValid(s with { LastSuccessUtc = now }, now));
    }

    [Theory]
    [InlineData("SSS")]
    [InlineData("SSF")]
    [InlineData("SSE")]
    [InlineData("SFS")]
    [InlineData("SFF")]
    [InlineData("SFE")]
    [InlineData("SES")]
    [InlineData("SEF")]
    [InlineData("SEE")]
    [InlineData("FSS")]
    [InlineData("FSF")]
    [InlineData("FSE")]
    [InlineData("FFS")]
    [InlineData("FFF")]
    [InlineData("FFE")]
    [InlineData("FES")]
    [InlineData("FEF")]
    [InlineData("FEE")]
    [InlineData("ESS")]
    [InlineData("ESF")]
    [InlineData("ESE")]
    [InlineData("EFS")]
    [InlineData("EFF")]
    [InlineData("EFE")]
    [InlineData("EES")]
    [InlineData("EEF")]
    [InlineData("EEE")]
    public void Every_possible_raw_interval_has_valid_counts_and_conservative_classification(string outcomes)
    {
        var now = DateTimeOffset.UtcNow;
        var summary = Summary(outcomes, now.AddMinutes(-2));
        Assert.True(ConnectivityClassifier.IsValid(summary, now));
        var state = ConnectivityClassifier.Apply(new ConnectivityLinkState(), summary, now);
        string expected = outcomes == "FFF" ? "Unreachable" : outcomes[2] == 'F' ? "Degraded" : outcomes[2] == 'S' ? "Reachable" : "Unknown";
        Assert.Equal(expected, state.Condition);
        Assert.Equal(outcomes == "FFF", state.IncidentOpen);
        Assert.Equal(now, state.ReceivedUtc);
        Assert.Equal(summary.LastObservedUtc, state.ObservedUtc);
    }

    [Fact]
    public void Incident_detected_and_recovered_inside_one_interval_preserves_observation_order()
    {
        var start = DateTimeOffset.UtcNow.AddMinutes(-5);
        var prior = ConnectivityClassifier.Apply(new ConnectivityLinkState(), Summary("SFF", start), start.AddMinutes(2));
        var recovered = ConnectivityClassifier.Apply(prior, Summary("FSE", start.AddMinutes(3)), start.AddMinutes(5));
        Assert.False(recovered.IncidentOpen);
        Assert.NotNull(recovered.IncidentObservedUtc);
        Assert.True(recovered.IncidentObservedUtc <= recovered.RecoveredObservedUtc);
        Assert.Equal(start.AddMinutes(3), recovered.IncidentObservedUtc);
    }

    [Fact]
    public void Contiguous_failures_cross_interval_boundary_but_gaps_and_local_errors_do_not()
    {
        var now = DateTimeOffset.UtcNow.AddMinutes(-8);
        var before = ConnectivityClassifier.Apply(new ConnectivityLinkState(), Summary("SFF", now), now.AddMinutes(2));
        Assert.False(before.IncidentOpen);
        var next = Summary("FEE", now.AddMinutes(3));
        var incident = ConnectivityClassifier.Apply(before, next, now.AddMinutes(5));
        Assert.True(incident.IncidentOpen);
        Assert.Equal("Unknown", incident.Condition);
        var gap = ConnectivityClassifier.Apply(before, Summary("FEE", now.AddMinutes(4)), now.AddMinutes(6));
        Assert.False(gap.IncidentOpen);
        var errors = ConnectivityClassifier.Apply(before, Summary("EFE", now.AddMinutes(3)), now.AddMinutes(5));
        Assert.False(errors.IncidentOpen);
        var recovered = ConnectivityClassifier.Apply(incident, Summary("ESS", now.AddMinutes(6)), now.AddMinutes(8));
        Assert.False(recovered.IncidentOpen);
        Assert.Equal(now.AddMinutes(8), recovered.RecoveredObservedUtc);
        Assert.Equal(recovered, ConnectivityClassifier.Apply(recovered, next, now.AddMinutes(10)));
    }

    [Fact]
    public void Threshold_at_unrecorded_middle_sample_is_unknown_not_last_failure_or_invented_midpoint()
    {
        var first = DateTimeOffset.UtcNow.AddMinutes(-5);
        var previous = ConnectivityClassifier.Apply(new ConnectivityLinkState(), Summary("SSF", first), first.AddMinutes(2));
        var summary = Summary("FFF", first.AddMinutes(3));
        var actual = ConnectivityClassifier.Apply(previous, summary, first.AddMinutes(6));
        Assert.True(actual.IncidentOpen);
        Assert.Null(actual.IncidentObservedUtc);
        Assert.Equal(first.AddMinutes(6), actual.IncidentReceivedUtc);
        Assert.Equal(first.AddMinutes(5), summary.LastFailureUtc);
    }

    internal static ConnectivitySummary Summary(string values, DateTimeOffset first)
    {
        int leading = values.TakeWhile(c => c == 'F').Count(), trailing = values.Reverse().TakeWhile(c => c == 'F').Count();
        int maximum = values.Split('S', 'E').Max(s => s.Length);
        return new ConnectivitySummary
        {
            Id = Guid.NewGuid(), ConfigurationId = Guid.NewGuid(), SourceCabinetId = Guid.NewGuid(), TargetCabinetId = Guid.NewGuid(),
            FirstObservedUtc = first, LastObservedUtc = first.AddMinutes(2), SuccessCount = values.Count(c => c == 'S'),
            FailureCount = values.Count(c => c == 'F'), ErrorCount = values.Count(c => c == 'E'),
            LeadingFailures = leading, TrailingFailures = trailing, MaximumFailureRun = maximum,
            LastSuccessUtc = values.Contains('S') ? first.AddMinutes(values.LastIndexOf('S')) : null,
            LastFailureUtc = values.Contains('F') ? first.AddMinutes(values.LastIndexOf('F')) : null
        };
    }
}

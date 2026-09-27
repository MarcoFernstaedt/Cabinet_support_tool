using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Services;
using Xunit;
using Xunit.Abstractions;
namespace CabinetPlatform.Server.Tests;

// Reviewer-only regression in a disposable archive. Never changes product implementation.
public sealed class ExtensionConnectivityChronologyTests(ITestOutputHelper output)
{
    [Fact]
    public void Cross_interval_threshold_then_reply_then_failure_preserves_incident_before_recovery()
    {
        var first = new DateTimeOffset(2026, 9, 19, 20, 0, 0, TimeSpan.Zero);
        var previous = new ConnectivityLinkState
        {
            TargetCabinetId=Guid.NewGuid(), ObservedUtc=first.AddMinutes(-1),
            ConsecutiveFailures=2, Condition="Degraded", IncidentOpen=false
        };
        var summary = new ConnectivitySummary
        {
            Id=Guid.NewGuid(), ConfigurationId=Guid.NewGuid(), SourceCabinetId=Guid.NewGuid(),
            TargetCabinetId=previous.TargetCabinetId, FirstObservedUtc=first, LastObservedUtc=first.AddMinutes(2),
            FailureCount=2, SuccessCount=1, ErrorCount=0, LeadingFailures=1, TrailingFailures=1,
            MaximumFailureRun=1, LastSuccessUtc=first.AddMinutes(1), LastFailureUtc=first.AddMinutes(2)
        };
        Assert.True(ConnectivityClassifier.IsValid(summary, first.AddMinutes(3)));
        var actual=ConnectivityClassifier.Apply(previous,summary,first.AddMinutes(3));
        output.WriteLine($"valid=True; priorFailures=2; interval=Failure,Reply,Failure; incident={actual.IncidentObservedUtc:O}; recovery={actual.RecoveredObservedUtc:O}; open={actual.IncidentOpen}; condition={actual.Condition}");
        Assert.False(actual.IncidentOpen);
        Assert.Equal(first.AddMinutes(1),actual.RecoveredObservedUtc);
        // The first failure crosses threshold; the final failure starts a new run of one.
        Assert.Equal(first,actual.IncidentObservedUtc);
        Assert.True(actual.IncidentObservedUtc<=actual.RecoveredObservedUtc);
    }
}

using System.Text.Json;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Services;

namespace CabinetPlatform.Server.Tests;

public sealed class ConnectivityAdjacentIntervalTests
{
    public static IEnumerable<object[]> Intervals()
    {
        foreach (var a in Patterns())
        foreach (var b in Patterns())
        foreach (var gap in new[] { false, true })
            yield return new object[] { a, b, gap };
    }

    private static IEnumerable<string> Patterns()
    {
        foreach (char a in "SFE")
        foreach (char b in "SFE")
        foreach (char c in "SFE")
            yield return new string(new[] { a, b, c });
    }

    [Theory]
    [MemberData(nameof(Intervals))]
    public void Adjacent_raw_intervals_match_sample_oracle_without_inventing_times(string before, string after, bool gap)
    {
        var first = new DateTimeOffset(2026, 9, 19, 18, 0, 0, TimeSpan.Zero);
        var prior = ConnectivityClassifierTests.Summary(before, first);
        var next = ConnectivityClassifierTests.Summary(after, first.AddMinutes(gap ? 4 : 3));
        var raw = JsonSerializer.Serialize(new[] { prior, next });
        Assert.True(ConnectivityClassifier.IsValid(prior, first.AddHours(1)));
        Assert.True(ConnectivityClassifier.IsValid(next, first.AddHours(1)));
        var state = ConnectivityClassifier.Apply(new ConnectivityLinkState(), prior, first.AddMinutes(10));
        var old = state;
        var count = gap ? 0 : before.Reverse().TakeWhile(c => c == 'F').Count();
        var open = before == "FFF";
        var incident = state.IncidentObservedUtc;
        var recovered = state.RecoveredObservedUtc;
        for (int i = 0; i < after.Length; i++)
        {
            char value = after[i];
            count = value == 'F' ? count + 1 : 0;
            if (!open && count >= 3)
            {
                open = true;
                // Only the middle time in FFF is absent from the raw contract.
                incident = i == 1 && after == "FFF" ? null : next.FirstObservedUtc.AddMinutes(i);
                recovered = null;
            }
            if (open && value == 'S')
            {
                open = false;
                // The contract retains the latest reply in the resolving interval,
                // not necessarily the first instant connectivity returned.
                recovered = next.LastSuccessUtc;
            }
        }
        var actual = ConnectivityClassifier.Apply(state, next, first.AddMinutes(11));
        Assert.Equal(open, actual.IncidentOpen);
        Assert.Equal(count, actual.ConsecutiveFailures);
        Assert.Equal(incident, actual.IncidentObservedUtc);
        Assert.Equal(recovered, actual.RecoveredObservedUtc);
        if (actual.IncidentObservedUtc is { } detected && actual.RecoveredObservedUtc is { } reply)
            Assert.True(detected <= reply);
        Assert.Equal(raw, JsonSerializer.Serialize(new[] { prior, next }));
        Assert.Equal(old, state);
    }
}

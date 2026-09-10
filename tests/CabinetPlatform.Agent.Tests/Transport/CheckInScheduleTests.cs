using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Transport;

namespace CabinetPlatform.Agent.Tests.Transport;

public class CheckInScheduleTests
{
    [Fact]
    public void NextInterval_SpreadsAroundTheConfiguredInterval()
    {
        var options = new AgentOptions { CheckInIntervalSeconds = 300, CheckInJitterPercent = 5 };

        // 0.0 and 1.0 are the ends of the random range, so they bound the spread.
        var earliest = CheckInSchedule.NextInterval(options, 0.0);
        var midpoint = CheckInSchedule.NextInterval(options, 0.5);
        var latest = CheckInSchedule.NextInterval(options, 1.0);

        Assert.Equal(285, earliest.TotalSeconds, precision: 3);
        Assert.Equal(300, midpoint.TotalSeconds, precision: 3);
        Assert.Equal(315, latest.TotalSeconds, precision: 3);
    }

    [Fact]
    public void NextInterval_IsCentredOnTheConfiguredIntervalRatherThanShiftingIt()
    {
        // A one-sided spread would drift the whole fleet's cadence away from
        // what was configured, a few percent at a time.
        var options = new AgentOptions { CheckInIntervalSeconds = 300, CheckInJitterPercent = 10 };

        var samples = Enumerable.Range(0, 1001)
            .Select(index => CheckInSchedule.NextInterval(options, index / 1000.0).TotalSeconds)
            .ToArray();

        Assert.Equal(300.0, samples.Average(), precision: 1);
    }

    [Fact]
    public void NextInterval_DecorrelatesCabinetsThatBootedTogether()
    {
        // The property that matters: cabinets on one clinic's power circuit
        // must not converge on the same second of every interval.
        var options = new AgentOptions { CheckInIntervalSeconds = 300, CheckInJitterPercent = 5 };
        var random = new Random(Seed: 20260910);

        var intervals = Enumerable.Range(0, 50)
            .Select(_ => CheckInSchedule.NextInterval(options, random.NextDouble()).TotalSeconds)
            .ToArray();

        Assert.True(
            intervals.Distinct().Count() > 40,
            "Cabinets checking in on nearly identical intervals would arrive in lockstep.");

        Assert.All(intervals, interval => Assert.InRange(interval, 285.0, 315.0));
    }

    [Fact]
    public void NextInterval_WithJitterDisabledReturnsExactlyTheConfiguredInterval()
    {
        var options = new AgentOptions { CheckInIntervalSeconds = 600, CheckInJitterPercent = 0 };

        Assert.Equal(TimeSpan.FromSeconds(600), CheckInSchedule.NextInterval(options, 0.7));
    }

    [Fact]
    public void BackoffDelay_GrowsWithConsecutiveFailures()
    {
        var options = new BackoffOptions { InitialSeconds = 30, MaximumSeconds = 1800, Multiplier = 2.0 };

        // With nextDouble at 1.0 the jitter contributes its full share, so the
        // undiluted growth curve is visible.
        Assert.Equal(30, CheckInSchedule.BackoffDelay(options, 1, 1.0).TotalSeconds, precision: 3);
        Assert.Equal(60, CheckInSchedule.BackoffDelay(options, 2, 1.0).TotalSeconds, precision: 3);
        Assert.Equal(120, CheckInSchedule.BackoffDelay(options, 3, 1.0).TotalSeconds, precision: 3);
        Assert.Equal(240, CheckInSchedule.BackoffDelay(options, 4, 1.0).TotalSeconds, precision: 3);
    }

    [Fact]
    public void BackoffDelay_NeverExceedsTheCeiling()
    {
        // Unbounded growth would silence a cabinet for days after a short
        // outage, which is a worse failure than the outage.
        var options = new BackoffOptions { InitialSeconds = 30, MaximumSeconds = 1800, Multiplier = 2.0 };

        foreach (var failures in new[] { 10, 50, 200, 1000, int.MaxValue })
        {
            var delay = CheckInSchedule.BackoffDelay(options, failures, 1.0);

            Assert.InRange(delay.TotalSeconds, 1.0, 1800.0);
        }
    }

    [Fact]
    public void BackoffDelay_StaysPositiveWhenTheExponentWouldOverflow()
    {
        // Math.Pow overflows to infinity long before int.MaxValue iterations,
        // and an infinite TimeSpan is a negative one.
        var options = new BackoffOptions { InitialSeconds = 30, MaximumSeconds = 1800, Multiplier = 10.0 };

        var delay = CheckInSchedule.BackoffDelay(options, int.MaxValue, 0.0);

        Assert.True(delay > TimeSpan.Zero);
        Assert.True(delay <= TimeSpan.FromSeconds(1800));
    }

    [Fact]
    public void BackoffDelay_SpreadsRetriesAcrossTheFleet()
    {
        // Every cabinet failed at the same moment when the server went down.
        // They must not all come back at the same moment either.
        var options = new BackoffOptions { InitialSeconds = 30, MaximumSeconds = 1800, Multiplier = 2.0 };
        var random = new Random(Seed: 20260910);

        var delays = Enumerable.Range(0, 50)
            .Select(_ => CheckInSchedule.BackoffDelay(options, 5, random.NextDouble()).TotalSeconds)
            .ToArray();

        Assert.True(delays.Distinct().Count() > 40);

        // Full jitter across the upper half of the window: never longer than
        // the nominal delay, never collapsing to nothing.
        Assert.All(delays, delay => Assert.InRange(delay, 240.0, 480.0));
    }

    [Fact]
    public void BackoffDelay_IsZeroWhenNothingHasFailed()
    {
        var options = new BackoffOptions();

        Assert.Equal(TimeSpan.Zero, CheckInSchedule.BackoffDelay(options, 0, 0.5));
    }
}

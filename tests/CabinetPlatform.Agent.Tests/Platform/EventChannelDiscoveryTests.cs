using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Platform;

public sealed class EventChannelDiscoveryTests
{
    [Fact]
    public void DiscoveryCapsNativeEnumerationAndProbes()
    {
        var gateway = new Gateway { Names = Enumerable.Range(0, 2000).Select(i => $"Vendor/{i}") };
        var result = Reader(gateway).DiscoverChannels(CancellationToken.None);
        Assert.Equal(1024, result.Channels.Count);
        Assert.True(result.Truncated);
        Assert.Equal(1024, gateway.Probes.Count);
        Assert.Equal(1025, gateway.Enumerated);
        Assert.True(gateway.Disposed);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void DiscoveryPreservesOtherChannelsWhenOneProbeFails(bool denied)
    {
        var gateway = new Gateway
        {
            Names = new[] { "Application", "Vendor/Restricted", "Vendor/Disabled" },
            OnProbe = name => name switch
            {
                "Vendor/Restricted" => throw (denied ? new UnauthorizedAccessException("private details") : new IOException("private details")),
                "Vendor/Disabled" => EventChannelAccess.Disabled,
                _ => EventChannelAccess.Readable,
            },
        };
        var result = Reader(gateway).DiscoverChannels(CancellationToken.None);
        Assert.Equal(EventChannelDiscoveryStatus.Available, result.Status);
        Assert.Equal(new[] { EventChannelAccess.Readable, denied ? EventChannelAccess.AccessDenied : EventChannelAccess.Unavailable,
            EventChannelAccess.Disabled }, result.Channels.Select(c => c.Access));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void EnumerationFailureReportsPartialInventoryNotSuccess(bool denied)
    {
        IEnumerable<string> Names()
        {
            yield return "Application";
            throw (denied ? new UnauthorizedAccessException("private details") : new IOException("private details"));
        }
        var gateway = new Gateway { Names = Names() };
        var result = Reader(gateway).DiscoverChannels(CancellationToken.None);
        Assert.Equal(denied ? EventChannelDiscoveryStatus.AccessDenied : EventChannelDiscoveryStatus.Unavailable, result.Status);
        Assert.Single(result.Channels);
        Assert.True(gateway.Disposed);
    }

    [Fact]
    public void DiscoveryHonoursCancellationEvenWithANonCooperativeGateway()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var gateway = new Gateway { Names = new[] { "Application" } };
        Assert.Throws<OperationCanceledException>(() => Reader(gateway).DiscoverChannels(cancellation.Token));
        Assert.Equal(0, gateway.Enumerated);
        Assert.Empty(gateway.Probes);
    }

    [Fact]
    public void DiscoveryDoesNotStartAnotherProbeAfterCancellation()
    {
        using var cancellation = new CancellationTokenSource();
        var gateway = new Gateway
        {
            Names = new[] { "Application", "System" },
            OnProbe = _ => { cancellation.Cancel(); return EventChannelAccess.Readable; },
        };
        Assert.Throws<OperationCanceledException>(() => Reader(gateway).DiscoverChannels(cancellation.Token));
        Assert.Single(gateway.Probes);
        Assert.True(gateway.Disposed);
    }

    [Fact]
    public void DiscoveryStopsAfterItsCooperativeTimeBudget()
    {
        var clock = new DiscoveryClock();
        var gateway = new Gateway
        {
            Names = new[] { "Application", "System" },
            OnProbe = _ => { clock.Timestamp += 2000; return EventChannelAccess.Readable; },
        };
        var reader = new EventLogReader(NullLogger<EventLogReader>.Instance, gateway, clock);
        var result = reader.DiscoverChannels(CancellationToken.None);
        Assert.Single(result.Channels);
        Assert.Single(gateway.Probes);
        Assert.Equal(1, gateway.Enumerated);
        Assert.True(result.Truncated);
        Assert.True(gateway.Disposed);
    }

    [Fact]
    public void DiscoveryDeduplicatesExactNativeNamesWithoutRepairingThem()
    {
        var gateway = new Gateway { Names = new[] { "Vendor/App", "vendor/app", "Application" } };
        var result = Reader(gateway).DiscoverChannels(CancellationToken.None);
        Assert.Equal(new[] { "Vendor/App", "Application" }, result.Channels.Select(c => c.Name));
        Assert.Equal(2, gateway.Probes.Count);
    }

    [Theory]
    [InlineData("")]
    [InlineData("bad\nchannel")]
    [InlineData(null)]
    public void InvalidNativeNamesAreNotProbedOrReportedAsComplete(string? invalid)
    {
        var gateway = new Gateway { Names = new[] { invalid!, new string('x', 513), "Application" } };
        var result = Reader(gateway).DiscoverChannels(CancellationToken.None);
        Assert.Equal(EventChannelDiscoveryStatus.Unavailable, result.Status);
        Assert.Equal("Application", Assert.Single(result.Channels).Name);
        Assert.Single(gateway.Probes);
    }

    [Fact]
    public void DuplicateNamesStillConsumeEnumerationBudget()
    {
        var gateway = new Gateway { Names = Enumerable.Repeat("Application", 2000) };
        var result = Reader(gateway).DiscoverChannels(CancellationToken.None);
        Assert.Single(result.Channels);
        Assert.True(result.Truncated);
        Assert.Single(gateway.Probes);
        Assert.Equal(1025, gateway.Enumerated);
    }

    private sealed class DiscoveryClock : TimeProvider
    {
        public long Timestamp { get; set; }
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => Timestamp;
    }

    private static EventLogReader Reader(Gateway gateway)
        => new(NullLogger<EventLogReader>.Instance, gateway);

    private sealed class Gateway : IEventChannelGateway
    {
        public IEnumerable<string> Names { get; init; } = Array.Empty<string>();
        public Func<string, EventChannelAccess> OnProbe { get; init; } = _ => EventChannelAccess.Readable;
        public List<string> Probes { get; } = new();
        public int Enumerated { get; private set; }
        public bool Disposed { get; private set; }
        public IEnumerable<string> GetChannelNames(CancellationToken cancellationToken)
        {
            try
            {
                foreach (var name in Names)
                {
                    Enumerated++;
                    yield return name;
                }
            }
            finally { Disposed = true; }
        }
        public EventChannelAccess Probe(string channelName, CancellationToken cancellationToken)
        {
            Probes.Add(channelName);
            return OnProbe(channelName);
        }
    }
}

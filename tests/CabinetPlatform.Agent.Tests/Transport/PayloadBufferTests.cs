using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Transport;

/// <summary>
/// The spool's caps are the guard against a monitoring tool causing the outage
/// it exists to report, so they are tested on both axes.
/// </summary>
public sealed class PayloadBufferTests : IDisposable
{
    private readonly string _directory;
    private readonly FixedClock _clock = new(new DateTimeOffset(2026, 9, 10, 12, 0, 0, TimeSpan.Zero));

    public PayloadBufferTests()
    {
        _directory = Path.Combine(Path.GetTempPath(), "cabinet-buffer-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_directory);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch (IOException)
        {
            // A leftover temp directory is not worth failing a test run over.
        }
    }

    [Fact]
    public void Enqueue_ThenPeek_RoundTripsThePayload()
    {
        var buffer = CreateBuffer();
        var payload = Payload("cabinet-a");

        Assert.True(buffer.Enqueue(payload, CheckInTier.Heartbeat));
        Assert.Equal(1, buffer.Count);

        var buffered = Assert.Single(buffer.PeekOldest(10));
        Assert.Equal("cabinet-a", buffered.Payload.MachineId);
        Assert.Equal(payload.CollectedAtUtc, buffered.Payload.CollectedAtUtc);
    }

    [Fact]
    public void PeekOldest_ReturnsOldestFirstSoAnOutageReplaysInOrder()
    {
        var buffer = CreateBuffer();

        for (var index = 0; index < 5; index++)
        {
            buffer.Enqueue(Payload($"payload-{index}"), CheckInTier.Heartbeat);
            _clock.Advance(TimeSpan.FromMinutes(5));
        }

        var buffered = buffer.PeekOldest(5);

        Assert.Equal(
            new[] { "payload-0", "payload-1", "payload-2", "payload-3", "payload-4" },
            buffered.Select(item => item.Payload.MachineId));
    }

    [Fact]
    public void PeekOldest_KeepsOrderForPayloadsWrittenInTheSameClockTick()
    {
        // The clock does not advance here at all. Without a tie-breaker in the
        // file name, replay order would be undefined.
        var buffer = CreateBuffer();

        for (var index = 0; index < 4; index++)
        {
            buffer.Enqueue(Payload($"same-tick-{index}"), CheckInTier.Heartbeat);
        }

        var buffered = buffer.PeekOldest(4);

        Assert.Equal(
            new[] { "same-tick-0", "same-tick-1", "same-tick-2", "same-tick-3" },
            buffered.Select(item => item.Payload.MachineId));
    }

    [Fact]
    public void Enqueue_DropsTheOldestOnceTheFileCountCapIsReached()
    {
        var buffer = CreateBuffer(maxFileCount: 3);

        for (var index = 0; index < 10; index++)
        {
            buffer.Enqueue(Payload($"payload-{index}"), CheckInTier.Heartbeat);
            _clock.Advance(TimeSpan.FromMinutes(5));
        }

        Assert.Equal(3, buffer.Count);

        // The newest survive: they describe the cabinet's current state.
        Assert.Equal(
            new[] { "payload-7", "payload-8", "payload-9" },
            buffer.PeekOldest(10).Select(item => item.Payload.MachineId));
    }

    [Fact]
    public void Enqueue_DropsTheOldestOnceTheSizeCapIsReached()
    {
        // A count cap alone is defeated by a handful of very large payloads,
        // which is exactly what a cabinet with a noisy event log produces.
        var buffer = CreateBuffer(maxFileCount: 10_000, maxTotalMegabytes: 1);

        for (var index = 0; index < 12; index++)
        {
            buffer.Enqueue(LargePayload($"payload-{index}"), CheckInTier.Heartbeat);
            _clock.Advance(TimeSpan.FromMinutes(5));
        }

        var totalBytes = new DirectoryInfo(_directory).GetFiles().Sum(file => file.Length);

        Assert.True(totalBytes <= 1024 * 1024, $"The spool held {totalBytes} bytes, above its 1 MB cap.");
        Assert.True(buffer.Count < 12, "Nothing was dropped despite the size cap being exceeded.");
    }

    [Fact]
    public void Enqueue_RejectsOversizedSampleWithoutEvictingQueuedReports()
    {
        var buffer = CreateBuffer(maxTotalMegabytes: 1);
        Assert.True(buffer.Enqueue(Payload("pending-report"), CheckInTier.Full));
        _clock.Advance(TimeSpan.FromMinutes(1));
        var oversized = Payload(new string('x', 1024 * 1024 + 1));

        Assert.False(buffer.Enqueue(oversized, CheckInTier.Heartbeat));

        Assert.Equal("pending-report", Assert.Single(buffer.PeekOldest(10)).Payload.MachineId);
    }

    [Fact]
    public void ALongOutageCannotGrowTheSpoolWithoutBound()
    {
        // Three days of five-minute check-ins is what a bank-holiday weekend
        // looks like to a cabinet whose server is down.
        var buffer = CreateBuffer(maxFileCount: 500, maxTotalMegabytes: 64);

        for (var index = 0; index < 864; index++)
        {
            buffer.Enqueue(Payload($"payload-{index}"), CheckInTier.Heartbeat);
            _clock.Advance(TimeSpan.FromMinutes(5));
        }

        Assert.Equal(500, buffer.Count);

        var totalBytes = new DirectoryInfo(_directory).GetFiles().Sum(file => file.Length);
        Assert.True(totalBytes <= 64L * 1024 * 1024);
    }

    [Fact]
    public void Remove_DeletesADeliveredPayload()
    {
        var buffer = CreateBuffer();
        buffer.Enqueue(Payload("delivered"), CheckInTier.Heartbeat);

        var buffered = Assert.Single(buffer.PeekOldest(10));
        buffer.Remove(buffered.Id);

        Assert.Equal(0, buffer.Count);
        Assert.Empty(buffer.PeekOldest(10));
    }

    [Fact]
    public void Remove_IsSafeForAnIdThatIsAlreadyGone()
    {
        var buffer = CreateBuffer();

        // A double delivery must not throw and take the tick down with it.
        buffer.Remove("20260910T120000000-000001");

        Assert.Equal(0, buffer.Count);
    }

    [Fact]
    public void PeekOldest_DiscardsAPayloadTruncatedByAPowerLoss()
    {
        var buffer = CreateBuffer();
        buffer.Enqueue(Payload("good"), CheckInTier.Heartbeat);

        // A file cut short mid-write can never be delivered. Left in place it
        // would block everything behind it in the queue forever.
        File.WriteAllText(Path.Combine(_directory, "20260101T000000000-000000.json"), "{\"machineId\": \"trunc");

        var buffered = buffer.PeekOldest(10);

        Assert.Equal("good", Assert.Single(buffered).Payload.MachineId);
        Assert.Equal(1, buffer.Count);
    }

    [Fact]
    public void PeekOldest_ReturnsNothingWhenAskedForNone()
    {
        var buffer = CreateBuffer();
        buffer.Enqueue(Payload("one"), CheckInTier.Heartbeat);

        Assert.Empty(buffer.PeekOldest(0));
    }

    private FilePayloadBuffer CreateBuffer(int maxFileCount = 100, int maxTotalMegabytes = 64)
    {
        var options = new AgentOptions();
        options.Buffer.Directory = _directory;
        options.Buffer.MaxFileCount = maxFileCount;
        options.Buffer.MaxTotalMegabytes = maxTotalMegabytes;

        return new FilePayloadBuffer(
            TestOptions.Create(options),
            _clock,
            NullLogger<FilePayloadBuffer>.Instance);
    }

    private CheckInPayload Payload(string machineId) => new()
    {
        AgentVersion = "1.0.0",
        MachineId = machineId,
        CollectedAtUtc = _clock.UtcNow,
    };

    /// <summary>A payload roughly the size of a real one with a full event log.</summary>
    private CheckInPayload LargePayload(string machineId) => Payload(machineId) with
    {
        EventLogs = Enumerable.Range(0, 300)
            .Select(index => new EventLogEntry
            {
                LogName = EventLogName.Application,
                EventId = 1000 + index,
                Level = EventLogLevel.Error,
                TimeCreatedUtc = _clock.UtcNow,
                Source = "A provider with a reasonably long name",
                Message = new string('x', 900),
            })
            .ToArray(),
    };
}

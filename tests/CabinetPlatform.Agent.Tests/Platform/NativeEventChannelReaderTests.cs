using System.Text.Json;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Platform;

public sealed class NativeEventChannelReaderTests
{
    [Fact]
    public async Task Native_only_saved_definition_reaches_reader_instead_of_empty_log_denial()
    {
        var definition = Definition();
        var request = Request(definition);
        var reader = new CapturingReader();
        var result = await new RunEventLogViewExecutor(reader, NullLogger<RunEventLogViewExecutor>.Instance).ExecuteAsync(request, default);
        Assert.Equal(ActionStatus.Succeeded, result.Status);
        Assert.Equal(definition.ChannelNames, reader.Seen!.ChannelNames);
    }

    [Fact]
    public async Task All_unavailable_channels_do_not_report_a_successful_empty_view()
    {
        var reader = new EventLogReader(NullLogger<EventLogReader>.Instance, new Channels(), records: new UnavailableRecords());
        var outcome = await new RunEventLogViewExecutor(reader, NullLogger<RunEventLogViewExecutor>.Instance)
            .ExecuteAsync(Request(Definition()), default);
        Assert.Equal(ActionStatus.Failed, outcome.Status);
        Assert.Null(outcome.CollectedData);
    }

    private sealed class UnavailableRecords : IEventRecordGateway
    {
        public IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken token)
            => throw new InvalidOperationException("Synthetic native failure");
    }

    [Theory]
    [InlineData("C:\\logs\\sample.evtx")]
    [InlineData("\\\\server\\Application")]
    [InlineData("*[System[Level=2]]")]
    [InlineData(" Vendor/Operational")]
    [InlineData("Vendor/../Application")]
    [InlineData("Vendor/*")]
    public async Task Unsafe_native_channels_are_denied_before_any_reader_call(string name)
    {
        var reader = new CapturingReader();
        var result = await new RunEventLogViewExecutor(reader, NullLogger<RunEventLogViewExecutor>.Instance)
            .ExecuteAsync(Request(Definition() with { ChannelNames = new[] { name } }), default);
        Assert.Equal(ActionStatus.Denied, result.Status);
        Assert.Null(reader.Seen);
    }

    [Fact]
    public void Native_queries_merge_newest_from_every_channel_and_report_partial_denial()
    {
        var gateway = new Records();
        var reader = new EventLogReader(NullLogger<EventLogReader>.Instance, new Channels(), records: gateway);
        var definition = Definition() with { ChannelNames = new[] { "Vendor/Older", "Vendor/Newer", "Vendor/Denied", "Vendor/Missing" } };
        var result = reader.RunViewResult(definition, default);
        Assert.Equal(new[] { "Vendor/Newer", "Vendor/Newer" }, result.Entries.Select(e => e.ChannelName));
        Assert.All(result.Entries, e => Assert.Null(e.LogName));
        Assert.Equal(4, gateway.Queried.Count);
        Assert.Equal(EventChannelAccess.AccessDenied, result.ChannelReads!.Single(c => c.Name == "Vendor/Denied").Access);
        Assert.Equal(EventChannelAccess.Unavailable, result.ChannelReads!.Single(c => c.Name == "Vendor/Missing").Access);
        Assert.True(result.Truncated);
    }

    [Fact]
    public async Task Malformed_or_unbounded_definitions_are_denied_before_reader()
    {
        var valid = Definition();
        var invalid = new[]
        {
            valid with { ChannelNames = null! }, valid with { Sources = null! }, valid with { EventIds = null! },
            valid with { MaximumEntries = 0 }, valid with { MaximumEntries = 5001 }, valid with { WindowHours = 169 },
            valid with { ChannelNames = Enumerable.Range(0, 17).Select(i => $"Vendor/{i}").ToArray() },
            valid with { ChannelNames = new string[] { null! } }, valid with { LogNames = new[] { (EventLogName)99 } }
        };
        foreach (var definition in invalid)
        {
            var reader = new CapturingReader();
            var outcome = await new RunEventLogViewExecutor(reader, NullLogger<RunEventLogViewExecutor>.Instance).ExecuteAsync(Request(definition), default);
            Assert.Equal(ActionStatus.Denied, outcome.Status);
            Assert.Null(reader.Seen);
        }
    }

    [Fact]
    public void Record_stream_is_bounded_and_disposed_and_cancellation_propagates()
    {
        var gateway = new InfiniteRecords();
        var reader = new EventLogReader(NullLogger<EventLogReader>.Instance, new Channels(), records: gateway);
        var result = reader.RunViewResult(Definition(), default);
        Assert.Equal(3, gateway.Moves);
        Assert.True(gateway.Disposed);
        Assert.Equal(2, result.Entries.Count);
        Assert.True(result.Truncated);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => reader.RunViewResult(Definition(), cancelled.Token));
        Assert.Equal(3, gateway.Moves);
    }

    [Fact]
    public void Disabled_and_mid_stream_failure_keep_separate_outcomes_and_partial_records()
    {
        var reader = new EventLogReader(NullLogger<EventLogReader>.Instance, new Channels(), records: new FailingRecords());
        var result = reader.RunViewResult(Definition() with { ChannelNames = new[] { "Vendor/Disabled", "Vendor/Partial" } }, default);
        Assert.Single(result.Entries);
        Assert.Equal(EventChannelAccess.Disabled, result.ChannelReads![0].Access);
        Assert.Equal(EventChannelAccess.Unavailable, result.ChannelReads[1].Access);
        Assert.Equal(1, result.ChannelReads[1].RecordsRead);
    }

    [Fact]
    public void Cooperative_budget_stops_starting_later_channel_reads_and_marks_them_unavailable()
    {
        var clock = new ReadClock();
        var gateway = new SlowRecords(clock);
        var reader = new EventLogReader(NullLogger<EventLogReader>.Instance, new Channels(), clock, gateway);
        var result = reader.RunViewResult(Definition() with { ChannelNames = new[] { "Vendor/Slow", "Vendor/NotStarted" } }, default);
        Assert.Equal(1, gateway.Starts);
        Assert.Equal(2, result.ChannelReads!.Count);
        Assert.All(result.ChannelReads, c => Assert.Equal(EventChannelAccess.Unavailable, c.Access));
    }

    [Fact]
    public void Native_timeout_is_retried_only_within_budget_and_null_is_a_real_empty_read()
    {
        var clock = new ReadClock();
        int calls = 0;
        var record = WindowsEventRecordGateway.ReadBounded<object>(timeout =>
        {
            Assert.Equal(TimeSpan.FromSeconds(1), timeout);
            calls++;
            clock.Timestamp += 1000;
            if (calls == 1) throw new TimeoutException();
            return null;
        }, clock, clock.GetTimestamp(), default, e => e is TimeoutException);
        Assert.Null(record);
        Assert.Equal(2, calls);
    }

    [Fact]
    public void Native_timeout_exhaustion_does_not_become_an_empty_read()
    {
        var clock = new ReadClock();
        int calls = 0;
        Assert.Throws<TimeoutException>(() => WindowsEventRecordGateway.ReadBounded<object>(_ =>
        {
            calls++;
            clock.Timestamp += 1000;
            throw new TimeoutException();
        }, clock, clock.GetTimestamp(), default, e => e is TimeoutException));
        Assert.Equal(10, calls);
    }

    [Fact]
    public void Native_non_timeout_failure_and_cancellation_are_not_retried()
    {
        var clock = new ReadClock();
        int calls = 0;
        Assert.Throws<InvalidOperationException>(() => WindowsEventRecordGateway.ReadBounded<object>(_ =>
        {
            calls++;
            throw new InvalidOperationException();
        }, clock, clock.GetTimestamp(), default));
        Assert.Equal(1, calls);
        using var source = new CancellationTokenSource();
        source.Cancel();
        Assert.Throws<OperationCanceledException>(() => WindowsEventRecordGateway.ReadBounded<object>(_ =>
        {
            calls++;
            return null;
        }, clock, clock.GetTimestamp(), source.Token));
        Assert.Equal(1, calls);
    }


    private sealed class ReadClock : TimeProvider
    {
        public long Timestamp { get; set; }
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => Timestamp;
    }

    private sealed class SlowRecords(ReadClock clock) : IEventRecordGateway
    {
        public int Starts { get; private set; }
        public IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken token)
        {
            Starts++;
            clock.Timestamp += 10001;
            yield return new EventLogEntry { ChannelName = channel, EventId = 1, Level = EventLogLevel.Warning, TimeCreatedUtc = DateTimeOffset.UtcNow };
        }
    }

    private sealed class FailingRecords : IEventRecordGateway
    {
        public IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken token)
        {
            if (channel.EndsWith("Disabled", StringComparison.Ordinal)) throw new EventChannelDisabledException();
            yield return new EventLogEntry { ChannelName = channel, EventId = 1, Level = EventLogLevel.Warning, TimeCreatedUtc = DateTimeOffset.UtcNow };
            throw new InvalidOperationException("synthetic native failure after a record");
        }
    }

    private sealed class InfiniteRecords : IEventRecordGateway
    {
        public int Moves { get; private set; }
        public bool Disposed { get; private set; }
        public IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken token)
        {
            try
            {
                while (true)
                {
                    Moves++;
                    yield return new EventLogEntry { ChannelName = channel, EventId = Moves, Level = EventLogLevel.Warning, TimeCreatedUtc = DateTimeOffset.UtcNow.AddSeconds(-Moves) };
                }
            }
            finally { Disposed = true; }
        }
    }

    internal sealed class Channels : IEventChannelGateway
    {
        public IEnumerable<string> GetChannelNames(CancellationToken token) => new[] { "Vendor/Older", "Vendor/Newer", "Vendor/Denied", "Vendor/Missing" };
        public EventChannelAccess Probe(string name, CancellationToken token) => EventChannelAccess.Readable;
    }

    internal sealed class Records : IEventRecordGateway
    {
        public List<string> Queried { get; } = new();
        public IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken token)
        {
            Queried.Add(channel);
            if (channel.EndsWith("Denied", StringComparison.Ordinal)) throw new UnauthorizedAccessException("not disclosed");
            if (channel.EndsWith("Missing", StringComparison.Ordinal)) throw new InvalidOperationException("not disclosed");
            return Enumerable.Range(0, 3).Select(i => new EventLogEntry
            {
                ChannelName = channel, LogName = null, EventId = i, Level = EventLogLevel.Information,
                TimeCreatedUtc = new DateTimeOffset(2026, 9, 13, channel.EndsWith("Newer", StringComparison.Ordinal) ? 20 : 10, 0, 0, TimeSpan.Zero).AddSeconds(-i)
            });
        }
    }

    internal static EventLogViewDefinition Definition() => new()
    {
        ViewId = Guid.NewGuid(), DisplayName = "Native synthetic view", ChannelNames = new[] { "Vendor/Operational" },
        WindowHours = 24, MaximumEntries = 2, MinimumLevel = EventLogLevel.Verbose
    };

    internal static ActionRequestDto Request(EventLogViewDefinition definition) => new()
    {
        Id = Guid.NewGuid(), Action = ActionName.RunEventLogView,
        Parameters = new Dictionary<string, string>
        {
            [ActionParameterKeys.EventLogViewId] = definition.ViewId.ToString(),
            [ActionParameterKeys.EventLogViewDefinition] = JsonSerializer.Serialize(definition, new JsonSerializerOptions(AgentJson.SerializerOptions)
            { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never })
        },
        Reason = "Synthetic native diagnostic", CabinetId = Guid.NewGuid(), RequestedByUserId = Guid.NewGuid(), RequestedUtc = DateTimeOffset.UtcNow
    };

    private sealed class CapturingReader : IEventLogReader
    {
        public EventLogViewDefinition? Seen { get; private set; }
        public IReadOnlyList<EventLogEntry> RunView(EventLogViewDefinition definition, CancellationToken token)
        { Seen = definition; return Array.Empty<EventLogEntry>(); }
        public IReadOnlyList<EventLogEntry> Read(EventLogName log, TimeSpan window, int count, CancellationToken token) => throw new NotSupportedException();
    }
}

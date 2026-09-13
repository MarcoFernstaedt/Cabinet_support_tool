using System.Text.Json;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Actions;

public sealed class EventChannelDiscoveryExecutorTests
{
    [Fact]
    public async Task ExistingViewReadIncludesExplicitDiscoveryAvailability()
    {
        var executor = new RunEventLogViewExecutor(new LegacyReader(), NullLogger<RunEventLogViewExecutor>.Instance);
        var outcome = await executor.ExecuteAsync(Request(), CancellationToken.None);
        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        using var json = JsonDocument.Parse(outcome.CollectedData!);
        Assert.True(json.RootElement.TryGetProperty("channelDiscovery", out var discovery),
            "A successful view read must distinguish unsupported discovery from an empty channel list.");
        Assert.Equal("Unavailable", discovery.GetProperty("status").GetString());
    }

    [Fact]
    public async Task ViewReadReturnsDynamicNamesThroughRealReaderDiscovery()
    {
        var gateway = new ChannelGateway();
        var reader = new EventLogReader(NullLogger<EventLogReader>.Instance, gateway);
        var executor = new RunEventLogViewExecutor(new DiscoveringReader(reader), NullLogger<RunEventLogViewExecutor>.Instance);
        var outcome = await executor.ExecuteAsync(Request(), CancellationToken.None);
        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        var view = JsonSerializer.Deserialize<EventLogViewResultDto>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        var result = Assert.IsType<EventChannelDiscoveryResult>(view.ChannelDiscovery);
        Assert.Equal(EventChannelDiscoveryStatus.Available, result.Status);
        Assert.Contains(result.Channels, c => c.Name == "Vendor-App/Operational" && c.Access == EventChannelAccess.Readable);
        Assert.False(result.Truncated);
        var section = new CabinetPlatform.Console.Core.Sections.EventLogSectionViewModel();
        section.ApplyResult(view);
        Assert.Contains(section.Channels, c => c.Name == "Vendor-App/Operational");
        Assert.Contains("2 readable", section.ResultSummary);
    }

    private sealed class ChannelGateway : IEventChannelGateway
    {
        public IEnumerable<string> GetChannelNames(CancellationToken cancellationToken)
            => new[] { "Vendor-App/Operational", "Application" };
        public EventChannelAccess Probe(string channelName, CancellationToken cancellationToken)
            => EventChannelAccess.Readable;
    }

    private static ActionRequestDto Request() => new()
    {
        Id = Guid.NewGuid(), CabinetId = Guid.NewGuid(), Action = ActionName.RunEventLogView,
        RequestedByUserId = Guid.NewGuid(), RequestedUtc = DateTimeOffset.UtcNow, Reason = "Inspect event channels",
        Parameters = new Dictionary<string, string>
        {
            [ActionParameterKeys.EventLogViewDefinition] = JsonSerializer.Serialize(new EventLogViewDefinition
            {
                ViewId = Guid.NewGuid(), DisplayName = "Application", LogNames = new[] { EventLogName.Application },
                MinimumLevel = EventLogLevel.Warning, WindowHours = 24, MaximumEntries = 50,
            }, AgentJson.SerializerOptions),
        },
    };

    private sealed class DiscoveringReader(IEventLogReader reader) : IEventLogReader
    {
        public EventChannelDiscoveryResult DiscoverChannels(CancellationToken cancellationToken)
            => reader.DiscoverChannels(cancellationToken);
        public IReadOnlyList<EventLogEntry> Read(EventLogName log, TimeSpan window, int maximumEntries,
            CancellationToken cancellationToken) => Array.Empty<EventLogEntry>();
        public IReadOnlyList<EventLogEntry> RunView(EventLogViewDefinition definition,
            CancellationToken cancellationToken) => Array.Empty<EventLogEntry>();
    }

    private sealed class LegacyReader : IEventLogReader
    {
        public IReadOnlyList<EventLogEntry> Read(EventLogName log, TimeSpan window, int maximumEntries,
            CancellationToken cancellationToken) => Array.Empty<EventLogEntry>();
        public IReadOnlyList<EventLogEntry> RunView(EventLogViewDefinition definition,
            CancellationToken cancellationToken) => Array.Empty<EventLogEntry>();
    }
}

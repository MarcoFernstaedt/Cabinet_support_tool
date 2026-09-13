using System.Diagnostics.Eventing.Reader;
using System.Runtime.Versioning;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

internal sealed class EventChannelDisabledException : Exception { }

/// <summary>Local, read-only native event queries. Never enables channels or opens files or remote sessions.</summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsEventRecordGateway : IEventRecordGateway
{
    public IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken token)
    {
        EventLogReader.ValidateDefinition(definition);
        if (!EventChannelName.IsValid(channel)) throw new ArgumentException("Invalid local event channel.");
        token.ThrowIfCancellationRequested();
        using (var configuration = new EventLogConfiguration(channel))
        {
            if (!configuration.IsEnabled) throw new EventChannelDisabledException();
        }
        var query = new EventLogQuery(channel, PathType.LogName,
            EventLogViewQueryBuilder.Build(definition, TimeSpan.FromHours(definition.WindowHours)))
        {
            ReverseDirection = true,
            TolerateQueryErrors = false
        };
        using var reader = new System.Diagnostics.Eventing.Reader.EventLogReader(query) { BatchSize = 1 };
        // Caller also caps and disposes the stream. This native boundary has its own cap.
        for (int examined = 0; examined <= definition.MaximumEntries; examined++)
        {
            token.ThrowIfCancellationRequested();
            using EventRecord? record = reader.ReadEvent(TimeSpan.FromMilliseconds(100));
            if (record is null) yield break;
            if (record.TimeCreated is not { } created) throw new EventLogException("Record timestamp unavailable.");
            string? message = null;
            try { message = record.FormatDescription(); }
            catch (EventLogException) { }
            if (message?.Length > 1000) message = message[..1000] + "...";
            string exactChannel = record.LogName ?? channel;
            EventLogName? legacy = Enum.TryParse<EventLogName>(exactChannel, true, out var log) && Enum.IsDefined(log) ? log : null;
            yield return new EventLogEntry
            {
                ChannelName = exactChannel, LogName = legacy, EventId = record.Id, Source = record.ProviderName,
                TimeCreatedUtc = new DateTimeOffset(created.ToUniversalTime(), TimeSpan.Zero),
                Level = EventLogReader.MapLevel(record.Level), Message = message
            };
        }
    }
}

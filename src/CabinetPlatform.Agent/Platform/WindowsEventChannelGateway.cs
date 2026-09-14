using System.Diagnostics.Eventing.Reader;
using System.Runtime.Versioning;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Local Windows API adapter. No remote sessions, channel writes or audit changes.</summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsEventChannelGateway : IEventChannelGateway
{
    /// <inheritdoc />
    public IEnumerable<string> GetChannelNames(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var session = new EventLogSession();
        foreach (string name in session.GetLogNames())
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return name;
        }
    }

    /// <inheritdoc />
    public EventChannelAccess Probe(string channelName, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var configuration = new EventLogConfiguration(channelName);
        if (!configuration.IsEnabled)
        {
            return EventChannelAccess.Disabled;
        }

        // Forward reading also works for channels that do not support reverse queries.
        // Reading at most one record proves more than merely reading channel metadata.
        var query = new EventLogQuery(channelName, PathType.LogName, "*");
        using var reader = new System.Diagnostics.Eventing.Reader.EventLogReader(query) { BatchSize = 1 };
        using var record = reader.ReadEvent(TimeSpan.FromMilliseconds(100));
        cancellationToken.ThrowIfCancellationRequested();
        return EventChannelAccess.Readable;
    }
}

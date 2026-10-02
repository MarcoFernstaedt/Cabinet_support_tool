using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Text;
using System.Xml;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Native-only XML must never be transported or logged.</summary>
public sealed record NativeProcessEvent(int EventId, string? Provider, DateTimeOffset OccurredUtc, string Xml, long? RecordId);
public interface IHistoricalProcessGateway
{
    IEnumerable<NativeProcessEvent> Read(DateTimeOffset since, DateTimeOffset until, CancellationToken token);
}

public sealed class WindowsHistoricalProcessGateway : IHistoricalProcessGateway
{
    public IEnumerable<NativeProcessEvent> Read(DateTimeOffset since, DateTimeOffset until, CancellationToken token)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var timer = Stopwatch.StartNew();
        // Both source and channel are fixed; never accept a remote session or file path.
        var query = new EventLogQuery("Security", PathType.LogName,
            "*[System[Provider[@Name='Microsoft-Windows-Security-Auditing'] and (EventID=4688 or EventID=4689) and TimeCreated[timediff(@SystemTime) <= 86400000]]]")
        { ReverseDirection = true, TolerateQueryErrors = false };
        using var reader = new System.Diagnostics.Eventing.Reader.EventLogReader(query) { BatchSize = 1 };
        // EvtNext's timeout is per call; opening the reader, rendering XML and disposal
        // are synchronous. The service invokes this only in a killable child process.
        for (int count = 0; count < 128; count++)
        {
            token.ThrowIfCancellationRequested();
            if (timer.Elapsed >= TimeSpan.FromSeconds(3)) throw new TimeoutException();
            using var record = reader.ReadEvent(TimeSpan.FromSeconds(1));
            if (record is null) yield break;
            // A native read can cross the cooperative deadline. Do not render its XML.
            if (timer.Elapsed >= TimeSpan.FromSeconds(3)) throw new TimeoutException();
            if (record.TimeCreated is not { } time) throw new InvalidDataException();
            yield return new NativeProcessEvent(record.Id, record.ProviderName,
                new DateTimeOffset(time.ToUniversalTime(), TimeSpan.Zero), record.ToXml(), record.RecordId);
        }
        // Do not query a look-ahead record merely to learn if the channel has more.
        throw new HistoricalProcessLimitException();
    }
}

public sealed class HistoricalProcessLimitException : Exception { }

public static class HistoricalProcessEventParser
{
    public static uint? ParsePid(string xml, int eventId)
    {
        if (Encoding.UTF8.GetByteCount(xml) > 16384) return null;
        try
        {
            using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null,
                MaxCharactersInDocument = 16384, MaxCharactersFromEntities = 0
            });
            string field = eventId == 4688 ? "NewProcessId" : "ProcessId";
            uint? pid = null;
            while (!reader.EOF)
            {
                if (reader.NodeType != XmlNodeType.Element || reader.LocalName != "Data" ||
                    reader.NamespaceURI is not ("" or "http://schemas.microsoft.com/win/2004/08/events/event") ||
                    reader.GetAttribute("Name") != field)
                { reader.Read(); continue; }
                if (pid is not null) return null;
                var text = reader.ReadElementContentAsString();
                var hex = text.StartsWith("0x", StringComparison.OrdinalIgnoreCase);
                if (!uint.TryParse(hex ? text[2..] : text,
                        hex ? NumberStyles.AllowHexSpecifier : NumberStyles.None,
                        CultureInfo.InvariantCulture, out var value) || value == 0) return null;
                pid = value;
            }
            return pid;
        }
        catch (XmlException) { return null; }
        catch (InvalidOperationException) { return null; }
    }
}

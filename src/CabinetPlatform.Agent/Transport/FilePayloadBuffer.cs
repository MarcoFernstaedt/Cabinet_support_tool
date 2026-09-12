using System.Globalization;
using System.Text.Json;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Transport;

/// <summary>
/// Spools undelivered check-ins to disk, under a hard cap.
/// </summary>
/// <remarks>
/// <para>
/// The cap is the point of this class. A cabinet checking in every five minutes
/// produces nearly three hundred payloads a day, each of which can run to
/// hundreds of kilobytes once the event log and software inventory are in it.
/// Left unbounded, a server outage over a long weekend would fill the disk of
/// every cabinet in the estate, and a tool bought to prevent outages would
/// cause one on a machine that dispenses controlled substances.
/// </para>
/// <para>
/// Both a file count and a total size are enforced, because either alone can be
/// defeated: a few very large payloads pass a count check, and a great many
/// small ones pass a size check. When the spool is over either bound the oldest
/// payloads are dropped, since the newest describe the cabinet's current state.
/// </para>
/// </remarks>
public sealed class FilePayloadBuffer : IPayloadBuffer
{
    private const string FileExtension = ".json";

    private readonly string _directory;
    private readonly BufferOptions _options;
    private readonly IClock _clock;
    private readonly ILogger<FilePayloadBuffer> _logger;
    private readonly object _gate = new();
    private int _sequence;

    public FilePayloadBuffer(
        IOptions<AgentOptions> options,
        IClock clock,
        ILogger<FilePayloadBuffer> logger)
    {
        _options = options.Value.Buffer;
        _clock = clock;
        _logger = logger;

        _directory = Path.GetFullPath(_options.Directory);
        Directory.CreateDirectory(_directory);
    }

    public int Count
    {
        get
        {
            lock (_gate)
            {
                return ListOldestFirst().Count;
            }
        }
    }

    /// <inheritdoc />
    public bool Enqueue(CheckInPayload payload, CheckInTier tier)
    {
        lock (_gate)
        {
            // The sequence number breaks ties between payloads written inside
            // the same clock tick, so replay order stays the order they were
            // collected in.
            var fileName = string.Create(
                CultureInfo.InvariantCulture,
                $"{_clock.UtcNow:yyyyMMddTHHmmssfff}-{Interlocked.Increment(ref _sequence):D6}-{tier}{FileExtension}");

            var path = Path.Combine(_directory, fileName);

            try
            {
                using var stream = File.Create(path);
                JsonSerializer.Serialize(stream, payload, AgentJson.SerializerOptions);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                _logger.LogError(e, "Could not spool a check-in payload to {Path}.", path);

                // A disk that is already full is exactly when this fails, and
                // exactly when pruning is most worth attempting.
                Prune();
                return false;
            }

            Prune();
            return true;
        }
    }

    /// <summary>
    /// Recovers the tier from the spooled file's name.
    /// </summary>
    /// <remarks>
    /// Carried in the name rather than inside the document, so the payload
    /// contract stays exactly what goes on the wire. A file written before the
    /// tiers existed, or one whose name has been mangled, replays as a
    /// heartbeat: the conservative choice, since a heartbeat stores strictly
    /// less than a full check-in.
    /// </remarks>
    /// <param name="fileName">The spooled file's name.</param>
    internal static CheckInTier ParseTier(string fileName)
    {
        string stem = Path.GetFileNameWithoutExtension(fileName);
        int separator = stem.LastIndexOf('-');

        return separator >= 0 &&
               Enum.TryParse(stem.AsSpan(separator + 1), ignoreCase: true, out CheckInTier tier) &&
               Enum.IsDefined(tier)
            ? tier
            : CheckInTier.Heartbeat;
    }

    /// <inheritdoc />
    public IReadOnlyList<BufferedPayload> PeekOldest(int maximumCount)
    {
        if (maximumCount <= 0)
        {
            return Array.Empty<BufferedPayload>();
        }

        lock (_gate)
        {
            var results = new List<BufferedPayload>();

            foreach (var file in ListOldestFirst())
            {
                if (results.Count >= maximumCount)
                {
                    break;
                }

                try
                {
                    using var stream = file.OpenRead();
                    var payload = JsonSerializer.Deserialize<CheckInPayload>(stream, AgentJson.SerializerOptions);

                    if (payload is null)
                    {
                        DeleteUnreadable(file, "it deserialised to nothing");
                        continue;
                    }

                    results.Add(new BufferedPayload
                    {
                        Id = Path.GetFileNameWithoutExtension(file.Name),
                        Payload = payload,
                        Tier = ParseTier(file.Name),
                    });
                }
                catch (JsonException e)
                {
                    // A payload truncated by a power loss mid-write can never
                    // be delivered, so it is discarded rather than blocking the
                    // queue behind it forever.
                    DeleteUnreadable(file, $"it is not valid JSON ({e.Message})");
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    _logger.LogWarning(e, "Buffered payload {File} could not be read.", file.Name);
                }
            }

            return results;
        }
    }

    public void Remove(string id)
    {
        lock (_gate)
        {
            var path = Path.Combine(_directory, id + FileExtension);

            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // The payload was delivered; failing to clean it up means it
                // may be delivered twice, which the server deduplicates on.
                _logger.LogWarning(e, "Delivered payload {Id} could not be removed from the spool.", id);
            }
        }
    }

    /// <summary>
    /// Drops the oldest payloads until the spool is inside both bounds.
    /// </summary>
    private void Prune()
    {
        var files = ListOldestFirst();
        var maximumBytes = (long)_options.MaxTotalMegabytes * 1024L * 1024L;
        var totalBytes = files.Sum(file => file.Length);
        var droppedCount = 0;
        var droppedBytes = 0L;

        var index = 0;
        while (index < files.Count &&
               (files.Count - droppedCount > _options.MaxFileCount || totalBytes > maximumBytes))
        {
            var file = files[index];
            index++;

            try
            {
                var length = file.Length;
                file.Delete();

                totalBytes -= length;
                droppedBytes += length;
                droppedCount++;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning(e, "Could not prune buffered payload {File}.", file.Name);
            }
        }

        if (droppedCount > 0)
        {
            // Dropped diagnostic data is a gap in the record, so it is stated
            // rather than left for someone to infer from missing timestamps.
            _logger.LogWarning(
                "Dropped {DroppedCount} buffered payloads ({DroppedKb} KB) to stay within the spool cap of " +
                "{MaxFileCount} files and {MaxMegabytes} MB. Those check-ins will not reach the server.",
                droppedCount,
                droppedBytes / 1024,
                _options.MaxFileCount,
                _options.MaxTotalMegabytes);
        }
    }

    private List<FileInfo> ListOldestFirst()
    {
        try
        {
            // The file name begins with a sortable timestamp, so ordering by
            // name is ordering by collection time and needs no extra stat call.
            return new DirectoryInfo(_directory)
                .GetFiles("*" + FileExtension)
                .OrderBy(file => file.Name, StringComparer.Ordinal)
                .ToList();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(e, "The payload spool at {Directory} could not be listed.", _directory);
            return new List<FileInfo>();
        }
    }

    private void DeleteUnreadable(FileInfo file, string reason)
    {
        _logger.LogWarning("Discarding buffered payload {File} because {Reason}.", file.Name, reason);

        try
        {
            file.Delete();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(e, "Unreadable payload {File} could not be deleted.", file.Name);
        }
    }
}

using System.Globalization;
using System.Text;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core;

/// <summary>
/// The agent's own limits (docs/spec/04-agent-spec.md), so even a compromised
/// server cannot flood a cabinet: 20 writes per hour, 10 network tests per
/// minute, 60 reads per minute. The write log is persisted so a restart does
/// not reset it.
/// </summary>
public sealed class RateLimiter
{
    public static readonly IReadOnlyDictionary<RateClass, (int Limit, TimeSpan Window)> Limits =
        new Dictionary<RateClass, (int, TimeSpan)>
        {
            [RateClass.Write] = (20, TimeSpan.FromHours(1)),
            [RateClass.NetworkTest] = (10, TimeSpan.FromMinutes(1)),
            [RateClass.Read] = (60, TimeSpan.FromMinutes(1)),
        };

    private readonly Dictionary<RateClass, Queue<DateTimeOffset>> _taken = new()
    {
        [RateClass.Write] = new(), [RateClass.NetworkTest] = new(), [RateClass.Read] = new(),
    };
    private readonly string? _writeLog;
    private readonly object _gate = new();

    public RateLimiter(string? writeLogFile, TimeProvider clock)
    {
        _writeLog = writeLogFile;
        if (writeLogFile is null || !File.Exists(writeLogFile)) return;
        DateTimeOffset now = clock.GetUtcNow();
        var (limit, window) = Limits[RateClass.Write];
        foreach (string line in File.ReadLines(writeLogFile))
        {
            if (!long.TryParse(line, NumberStyles.None, CultureInfo.InvariantCulture, out long ms) ||
                ms > DateTimeOffset.MaxValue.ToUnixTimeMilliseconds()) continue;
            DateTimeOffset at = DateTimeOffset.FromUnixTimeMilliseconds(ms);
            // A future time in the log (clock moved back) still counts, so the limit cannot be dodged by changing the clock.
            if (now - at < window) _taken[RateClass.Write].Enqueue(at);
        }
        while (_taken[RateClass.Write].Count > limit) _taken[RateClass.Write].Dequeue();
    }

    /// <summary>Takes one slot if the class is under its limit.</summary>
    public bool TryTake(RateClass rateClass, DateTimeOffset now)
    {
        var (limit, window) = Limits[rateClass];
        lock (_gate)
        {
            Queue<DateTimeOffset> taken = _taken[rateClass];
            while (taken.Count > 0 && now - taken.Peek() >= window) taken.Dequeue();
            if (taken.Count >= limit) return false;
            taken.Enqueue(now);
            if (rateClass == RateClass.Write && _writeLog is not null)
            {
                var text = new StringBuilder();
                foreach (DateTimeOffset at in taken) text.Append(at.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)).Append('\n');
                AtomicFile.Write(_writeLog, text.ToString());
            }
            return true;
        }
    }
}

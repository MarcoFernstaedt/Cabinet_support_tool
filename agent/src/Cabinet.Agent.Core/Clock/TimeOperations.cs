using System.Globalization;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Clock;

/// <summary>What Windows can tell about the time zone and clock, and do to them. Implemented on a cabinet with tzutil and w32tm.</summary>
public interface ITimePlatform
{
    /// <summary>The time zone Windows uses now (read fresh, not cached).</summary>
    TimeZoneInfo CurrentZone();
    DateTimeOffset UtcNow();
    TimeServiceState ServiceState();
    /// <summary>The text of <c>w32tm /query /status</c>, or null when it could not be read.</summary>
    string? QueryStatus();
    /// <summary>True when Group Policy sets Windows Time's source.</summary>
    bool PolicyManaged();
    /// <summary>Sets the zone (<c>tzutil /s</c>); returns the program's exit code.</summary>
    int SetZone(string timeZoneId);
    /// <summary>Asks Windows Time to synchronize now (<c>w32tm /resync</c>); returns the program's exit code.</summary>
    int Resync();
}

/// <summary>The time rules compiled into the agent: the zones it may set, and how it reads Windows Time's status.</summary>
public static class TimeRules
{
    /// <summary>The zones the platform may set (contracts: common timeZoneId). Arizona is US Mountain Standard Time.</summary>
    public static readonly IReadOnlySet<string> AllowedZones = new HashSet<string>(StringComparer.Ordinal)
    {
        "Eastern Standard Time", "Central Standard Time", "Mountain Standard Time", "US Mountain Standard Time",
        "Pacific Standard Time", "Alaskan Standard Time", "Hawaiian Standard Time",
    };

    private const string ReportableExtra = " ()+.,'-";

    /// <summary>The contract's reportedTimeZoneId: 1 to 64 letters, digits, spaces and a few punctuation marks.</summary>
    public static bool IsReportable(string? id) =>
        id is { Length: > 0 and <= 64 } && id.All(c => char.IsAsciiLetterOrDigit(c) || ReportableExtra.Contains(c));

    /// <summary>The cabinet's zone for the heartbeat, or null when it cannot be read or is not a reportable ID.</summary>
    public static string? CurrentReportableZone()
    {
        try
        {
            TimeZoneInfo.ClearCachedData();
            string id = TimeZoneInfo.Local.Id;
            return IsReportable(id) ? id : null;
        }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException or InvalidOperationException) { return null; }
    }

    /// <summary>
    /// Reads "Source:" and "Last Successful Sync Time:" from <c>w32tm /query /status</c>. The labels are matched as plain
    /// text; the time is in the cabinet's own culture and zone. Anything that cannot be read is unknown, never guessed.
    /// </summary>
    public static TimeSync ParseStatus(string? output, TimeZoneInfo zone, CultureInfo culture)
    {
        if (output is null) return new TimeSync { State = TimeSyncState.Unknown, Source = null, LastSuccessfulSync = null };
        string? source = null, last = null;
        foreach (string raw in output.Split('\n'))
        {
            string line = raw.Trim();
            if (ValueAfter(line, "Source:") is { } s) source = s;
            else if (ValueAfter(line, "Last Successful Sync Time:") is { } l) last = l;
        }
        source = source is null ? null : Clean(source);
        if (last is null) return new TimeSync { State = TimeSyncState.Unknown, Source = source, LastSuccessfulSync = null };
        if (last.Equals("unspecified", StringComparison.OrdinalIgnoreCase))
            return new TimeSync { State = TimeSyncState.NeverSynced, Source = source, LastSuccessfulSync = null };
        if (DateTime.TryParse(last, culture, DateTimeStyles.AllowWhiteSpaces, out DateTime local))
        {
            DateTime unspecified = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
            if (!zone.IsInvalidTime(unspecified))
                return new TimeSync { State = TimeSyncState.Synced, Source = source, LastSuccessfulSync = new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(unspecified, zone), TimeSpan.Zero) };
        }
        return new TimeSync { State = TimeSyncState.Unknown, Source = source, LastSuccessfulSync = null };
    }

    private static string? ValueAfter(string line, string label) =>
        line.StartsWith(label, StringComparison.OrdinalIgnoreCase) ? line[label.Length..].Trim() : null;

    /// <summary>A single line with no control characters, at most 256 characters (the contract's shortText).</summary>
    public static string Clean(string text)
    {
        string clean = new(text.Where(c => !char.IsControl(c)).ToArray());
        return clean.Length <= 256 ? clean : clean[..256];
    }
}

/// <summary>time.status, time.setZone and time.sync as the broker runs them.</summary>
public sealed class TimeOperations(ITimePlatform platform, Action<string> log, CultureInfo? culture = null)
{
    private readonly CultureInfo _culture = culture ?? CultureInfo.CurrentCulture;

    public OperationRegistry Register(OperationRegistry registry) => registry
        .Register<EmptyParams, TimeStatusOutput>(Catalog.TimeStatus, (_, _) => Task.FromResult(Status()))
        .Register<TimeSetZoneParams, TimeSetZoneOutput>(Catalog.TimeSetZone, (p, _) => Task.FromResult(SetZone(p)))
        .Register<EmptyParams, TimeSyncOutput>(Catalog.TimeSync, (_, _) => Task.FromResult(Sync()));

    public TimeStatusOutput Status()
    {
        TimeZoneInfo zone = platform.CurrentZone();
        DateTimeOffset utc = platform.UtcNow();
        DateTime local = TimeZoneInfo.ConvertTimeFromUtc(utc.UtcDateTime, zone);
        TimeServiceState service = platform.ServiceState();
        return new TimeStatusOutput
        {
            TimeZoneId = TimeRules.IsReportable(zone.Id) ? zone.Id : throw new OperationFailedException("execution_failed", "The cabinet's time zone has an ID the agent cannot report."),
            TimeZoneName = TimeRules.Clean(zone.DisplayName),
            UtcOffsetMinutes = (int)zone.GetUtcOffset(utc).TotalMinutes,
            DaylightSavingNow = zone.IsDaylightSavingTime(utc),
            LocalTime = local.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture),
            UtcTime = new DateTimeOffset(utc.UtcDateTime.AddTicks(-(utc.UtcDateTime.Ticks % TimeSpan.TicksPerSecond)), TimeSpan.Zero),
            TimeService = service,
            Sync = service == TimeServiceState.Running ? TimeRules.ParseStatus(platform.QueryStatus(), zone, _culture)
                : new TimeSync { State = TimeSyncState.Unknown, Source = null, LastSuccessfulSync = null },
            PolicyManaged = platform.PolicyManaged(),
        };
    }

    public TimeSetZoneOutput SetZone(TimeSetZoneParams p)
    {
        // Checked again here, whatever the schema said: only the compiled-in zones ever reach tzutil.
        if (!TimeRules.AllowedZones.Contains(p.TimeZoneId)) throw new OperationFailedException("invalid_params", "That time zone is not one the platform may set.");
        string before = platform.CurrentZone().Id;
        if (before == p.TimeZoneId) return new TimeSetZoneOutput { Before = before, After = before };
        int exit = platform.SetZone(p.TimeZoneId);
        string after = platform.CurrentZone().Id;
        if (exit != 0 || after != p.TimeZoneId)
        {
            log($"Time zone: setting {p.TimeZoneId} failed (tzutil exit {exit}); now {after}.");
            throw new OperationFailedException("execution_failed", $"Windows did not change the time zone (tzutil exit code {exit}).");
        }
        log($"Time zone: {before} -> {after}.");
        return new TimeSetZoneOutput { Before = TimeRules.IsReportable(before) ? before : "unknown", After = after };
    }

    public TimeSyncOutput Sync()
    {
        TimeZoneInfo zone = platform.CurrentZone();
        if (platform.ServiceState() != TimeServiceState.Running)
            return new TimeSyncOutput { Result = TimeSyncResult.ServiceStopped, Message = "Windows Time is not running, so nothing was tried. Start the Windows Time service, then sync again.",
                LastSuccessfulSyncBefore = null, LastSuccessfulSyncAfter = null };
        TimeSync before = TimeRules.ParseStatus(platform.QueryStatus(), zone, _culture);
        int exit = platform.Resync();
        TimeSync after = TimeRules.ParseStatus(platform.QueryStatus(), zone, _culture);
        log($"Time sync: w32tm exit {exit}.");
        string source = after.Source ?? before.Source ?? "its time source";
        return exit == 0
            ? new TimeSyncOutput { Result = TimeSyncResult.Synced, Message = TimeRules.Clean($"Windows Time synchronized the clock with {source}."),
                LastSuccessfulSyncBefore = before.LastSuccessfulSync, LastSuccessfulSyncAfter = after.LastSuccessfulSync }
            : new TimeSyncOutput { Result = TimeSyncResult.Failed, Message = TimeRules.Clean($"Windows Time could not synchronize with {source} (w32tm exit code {exit})."),
                LastSuccessfulSyncBefore = before.LastSuccessfulSync, LastSuccessfulSyncAfter = after.LastSuccessfulSync };
    }
}

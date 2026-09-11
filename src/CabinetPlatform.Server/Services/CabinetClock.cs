using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Domain;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Services;

/// <summary>
/// Everything this server does with a cabinet's own clock and calendar.
/// </summary>
/// <remarks>
/// <para>
/// The fleet spans thirteen countries. A maintenance window of 02:00 to 04:00
/// means 02:00 <em>at the cabinet</em>, and evaluating it against the server's
/// clock would run a reboot in the middle of a clinic's afternoon somewhere.
/// This is a correctness requirement, not a formatting preference, so it lives
/// in one service with tests rather than being re-derived per caller.
/// </para>
/// <para>
/// Everything stored and transmitted stays UTC, as
/// <see cref="DateTimeOffset"/>. Local time exists only at the two edges: the
/// window comparison here, and the display in the console.
/// </para>
/// </remarks>
public interface ICabinetClock
{
    /// <summary>
    /// Resolves a cabinet's time zone, or null when it has not reported one or
    /// reported one this host does not know.
    /// </summary>
    /// <param name="cabinet">The cabinet.</param>
    TimeZoneInfo? ResolveZone(Cabinet cabinet);

    /// <summary>Converts an instant into a cabinet's local time.</summary>
    /// <param name="cabinet">The cabinet.</param>
    /// <param name="instant">The instant to convert.</param>
    /// <returns>The local time, or null when the zone is unknown.</returns>
    DateTimeOffset? ToCabinetLocal(Cabinet cabinet, DateTimeOffset instant);

    /// <summary>
    /// Whether an instant falls inside the cabinet's maintenance window, judged
    /// in the cabinet's own zone.
    /// </summary>
    /// <param name="cabinet">The cabinet.</param>
    /// <param name="instant">The instant to test.</param>
    bool IsInMaintenanceWindow(Cabinet cabinet, DateTimeOffset instant);
}

/// <inheritdoc />
public sealed class CabinetClock : ICabinetClock
{
    private readonly ActionOptions _options;
    private readonly ILogger<CabinetClock> _logger;

    /// <summary>Creates the service.</summary>
    /// <param name="options">Maintenance window configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    public CabinetClock(IOptions<ActionOptions> options, ILogger<CabinetClock> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    /// <inheritdoc />
    public TimeZoneInfo? ResolveZone(Cabinet cabinet)
    {
        if (string.IsNullOrWhiteSpace(cabinet.TimeZoneId))
        {
            return null;
        }

        try
        {
            // Windows agents report Windows zone ids and this server may run on
            // Linux, so the lookup goes through the conversion .NET 8 performs
            // for us rather than assuming either family.
            return TimeZoneInfo.FindSystemTimeZoneById(cabinet.TimeZoneId);
        }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            // A zone this host cannot resolve is reported as unknown rather
            // than silently falling back to the server's own: a maintenance
            // window evaluated in the wrong zone is worse than one that
            // refuses to evaluate.
            _logger.LogWarning(
                e,
                "Cabinet {CabinetId} reported time zone {TimeZoneId}, which this host cannot resolve.",
                cabinet.Id,
                cabinet.TimeZoneId);
            return null;
        }
    }

    /// <inheritdoc />
    public DateTimeOffset? ToCabinetLocal(Cabinet cabinet, DateTimeOffset instant)
    {
        TimeZoneInfo? zone = ResolveZone(cabinet);
        return zone is null ? null : TimeZoneInfo.ConvertTime(instant, zone);
    }

    /// <inheritdoc />
    public bool IsInMaintenanceWindow(Cabinet cabinet, DateTimeOffset instant)
    {
        DateTimeOffset? local = ToCabinetLocal(cabinet, instant);

        if (local is null)
        {
            // No zone, no window. Refusing is the safe answer: a disruptive
            // action that would only run inside a window must not run because
            // the window could not be evaluated.
            return false;
        }

        return IsWithin(
            local.Value.TimeOfDay,
            TimeSpan.FromHours(_options.MaintenanceWindowStartHourLocal),
            TimeSpan.FromHours(_options.MaintenanceWindowEndHourLocal));
    }

    /// <summary>
    /// Whether a time of day falls inside a window, handling a window that
    /// crosses midnight.
    /// </summary>
    /// <remarks>
    /// 22:00 to 04:00 is an ordinary maintenance window and is two intervals,
    /// not one. Comparing it as a single range silently matches nothing.
    /// </remarks>
    /// <param name="timeOfDay">The time to test.</param>
    /// <param name="start">Window start.</param>
    /// <param name="end">Window end.</param>
    internal static bool IsWithin(TimeSpan timeOfDay, TimeSpan start, TimeSpan end) =>
        start <= end
            ? timeOfDay >= start && timeOfDay < end
            : timeOfDay >= start || timeOfDay < end;
}

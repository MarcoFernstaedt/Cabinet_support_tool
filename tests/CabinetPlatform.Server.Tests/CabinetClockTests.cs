using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// A maintenance window means 02:00 at the cabinet, not 02:00 at the server.
/// </summary>
/// <remarks>
/// <para>
/// The fleet spans thirteen countries. Evaluating a window against the server's
/// clock would run a reboot in the middle of a clinic's afternoon somewhere, and
/// nothing about the failure would announce itself: the action would simply
/// succeed, at the wrong time, on a cabinet a clinician was standing at.
/// </para>
/// <para>
/// Every case here is one that a naive implementation gets wrong: a cabinet on
/// the far side of the world where the window falls on the previous UTC day, a
/// window that crosses midnight, and the hour that does not exist at all on the
/// morning a zone springs forward.
/// </para>
/// </remarks>
public sealed class CabinetClockTests
{
    /// <summary>02:00 to 06:00 in the cabinet's own zone, the shipped default.</summary>
    private static CabinetClock Clock(int startHour = 2, int endHour = 6) =>
        new(
            Options.Create(new ActionOptions
            {
                MaintenanceWindowStartHourLocal = startHour,
                MaintenanceWindowEndHourLocal = endHour,
            }),
            NullLogger<CabinetClock>.Instance);

    private static Cabinet In(string timeZoneId) => new()
    {
        MachineId = "machine",
        Hostname = "CUBEX-TZ",
        TimeZoneId = timeZoneId,
    };

    [Fact]
    public void A_cabinet_several_zones_away_is_judged_by_its_own_clock()
    {
        // 09:00 UTC. In Auckland that is 21:00 or 22:00 depending on the season;
        // in Los Angeles it is either 01:00 or 02:00. The server's own clock is
        // irrelevant to both, and that is the point.
        var instant = new DateTimeOffset(2026, 6, 15, 9, 0, 0, TimeSpan.Zero);

        Cabinet auckland = In("Pacific/Auckland");
        Cabinet chicago = In("America/Chicago");

        CabinetClock clock = Clock();

        // Auckland: 21:00 local in June (NZST, UTC+12). Evening, not the window.
        DateTimeOffset aucklandLocal = clock.ToCabinetLocal(auckland, instant)!.Value;

        Assert.Equal(21, aucklandLocal.Hour);
        Assert.False(clock.IsInMaintenanceWindow(auckland, instant));

        // Chicago: 04:00 local in June (CDT, UTC-5). Inside the window.
        DateTimeOffset chicagoLocal = clock.ToCabinetLocal(chicago, instant)!.Value;

        Assert.Equal(4, chicagoLocal.Hour);
        Assert.True(clock.IsInMaintenanceWindow(chicago, instant));
    }

    [Fact]
    public void A_window_that_falls_on_the_previous_calendar_day_in_UTC_is_still_the_window()
    {
        // The date-boundary case. 14:00 UTC on 15 June is 03:00 on 16 June in
        // Auckland: a different day, inside the window. An implementation that
        // compared UTC hours, or that took the date from the server, would miss
        // this entirely — and would miss it only for the cabinets furthest from
        // the server, which are the ones nobody is watching.
        var instant = new DateTimeOffset(2026, 6, 15, 15, 0, 0, TimeSpan.Zero);

        Cabinet auckland = In("Pacific/Auckland");
        CabinetClock clock = Clock();

        DateTimeOffset local = clock.ToCabinetLocal(auckland, instant)!.Value;

        Assert.Equal(16, local.Day);
        Assert.Equal(3, local.Hour);
        Assert.True(clock.IsInMaintenanceWindow(auckland, instant));

        // And the same instant is the middle of the previous afternoon in
        // Chicago, where the window must not open.
        Cabinet chicago = In("America/Chicago");

        DateTimeOffset chicagoLocal = clock.ToCabinetLocal(chicago, instant)!.Value;

        Assert.Equal(15, chicagoLocal.Day);
        Assert.Equal(10, chicagoLocal.Hour);
        Assert.False(clock.IsInMaintenanceWindow(chicago, instant));
    }

    [Fact]
    public void A_window_that_crosses_midnight_is_two_intervals_and_not_an_empty_one()
    {
        // 22:00 to 04:00 is an ordinary window and the one a naive comparison
        // silently matches nothing for, because start is after end.
        CabinetClock clock = Clock(startHour: 22, endHour: 4);
        Cabinet london = In("Europe/London");

        // 23:30 London time on 14 January is 23:30 UTC (GMT in winter).
        Assert.True(clock.IsInMaintenanceWindow(
            london, new DateTimeOffset(2026, 1, 14, 23, 30, 0, TimeSpan.Zero)));

        // 02:30 the next morning, still inside.
        Assert.True(clock.IsInMaintenanceWindow(
            london, new DateTimeOffset(2026, 1, 15, 2, 30, 0, TimeSpan.Zero)));

        // 05:00, just outside the far end.
        Assert.False(clock.IsInMaintenanceWindow(
            london, new DateTimeOffset(2026, 1, 15, 5, 0, 0, TimeSpan.Zero)));

        // 12:00, the middle of the clinic's day.
        Assert.False(clock.IsInMaintenanceWindow(
            london, new DateTimeOffset(2026, 1, 15, 12, 0, 0, TimeSpan.Zero)));
    }

    [Fact]
    public void A_cabinet_with_no_resolvable_zone_is_never_inside_the_window()
    {
        CabinetClock clock = Clock();

        // Reported nothing.
        Assert.Null(clock.ResolveZone(In(string.Empty)));
        Assert.False(clock.IsInMaintenanceWindow(
            In(string.Empty), new DateTimeOffset(2026, 6, 15, 3, 0, 0, TimeSpan.Zero)));

        // Reported something this host does not know. Refusing beats falling
        // back to the server's own zone: a window evaluated in the wrong zone
        // is worse than one that will not evaluate, because it looks like it
        // worked.
        Assert.Null(clock.ResolveZone(In("Mars/Olympus_Mons")));
        Assert.False(clock.IsInMaintenanceWindow(
            In("Mars/Olympus_Mons"), new DateTimeOffset(2026, 6, 15, 3, 0, 0, TimeSpan.Zero)));
    }

    [Fact]
    public void The_window_holds_its_local_hour_across_a_daylight_saving_transition()
    {
        // Chicago springs forward at 02:00 local on 8 March 2026. 03:00 local is
        // 09:00 UTC before the change and 08:00 UTC after it. A window pinned to
        // a UTC hour would drift an hour off the clinic's night twice a year,
        // in opposite directions in the northern and southern halves of the
        // fleet.
        Cabinet chicago = In("America/Chicago");

        // A narrow window, 02:00 to 04:00, so that an hour's drift moves an
        // instant across its edge and the test can see it.
        CabinetClock clock = Clock(startHour: 2, endHour: 4);

        // One UTC hour, on both sides of the transition, showing the window
        // move with the clinic rather than with the server.
        //
        // 7 March, 09:00 UTC is 03:00 CST: inside.
        Assert.True(clock.IsInMaintenanceWindow(
            chicago, new DateTimeOffset(2026, 3, 7, 9, 0, 0, TimeSpan.Zero)));

        // 9 March, the same 09:00 UTC is 04:00 CDT: outside, because the
        // cabinet's clock moved and the window moved with it.
        Assert.False(clock.IsInMaintenanceWindow(
            chicago, new DateTimeOffset(2026, 3, 9, 9, 0, 0, TimeSpan.Zero)));

        // 03:00 local on 9 March is now 08:00 UTC, and is inside — the same
        // local hour as the first case, an hour earlier in UTC.
        Assert.True(clock.IsInMaintenanceWindow(
            chicago, new DateTimeOffset(2026, 3, 9, 8, 0, 0, TimeSpan.Zero)));

        // And 01:00 local is outside on either side of the change.
        Assert.False(clock.IsInMaintenanceWindow(
            chicago, new DateTimeOffset(2026, 3, 7, 7, 0, 0, TimeSpan.Zero)));
        Assert.False(clock.IsInMaintenanceWindow(
            chicago, new DateTimeOffset(2026, 3, 9, 6, 0, 0, TimeSpan.Zero)));
    }

    [Fact]
    public void An_install_scheduled_into_the_hour_a_zone_skips_is_refused_rather_than_moved()
    {
        // On 8 March 2026 in Chicago, 02:30 local does not happen: the clock
        // goes from 01:59:59 CST to 03:00:00 CDT. Silently sliding the install
        // to 03:30 would put an update on a cabinet an hour later than the rep
        // agreed with the clinic, and nothing would say so.
        var validator = new ActionParameterValidator(
            new ServiceAllowList(Options.Create(new ServiceAllowListOptions())));

        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.ScheduleUpdates);
        Cabinet chicago = In("America/Chicago");
        CabinetClock clock = Clock();

        var nowUtc = new DateTimeOffset(2026, 3, 1, 0, 0, 0, TimeSpan.Zero);

        OperationResult<IReadOnlyDictionary<string, string>> skipped = validator.Validate(
            entry,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ScheduledForLocal] = "2026-03-08T02:30:00",
            },
            nowUtc,
            chicago,
            clock);

        Assert.False(skipped.Succeeded);
        Assert.Contains("does not exist", skipped.Reason!, StringComparison.OrdinalIgnoreCase);

        // An hour later is a real local time and is accepted.
        OperationResult<IReadOnlyDictionary<string, string>> fine = validator.Validate(
            entry,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ScheduledForLocal] = "2026-03-08T03:30:00",
            },
            nowUtc,
            chicago,
            clock);

        Assert.True(fine.Succeeded);

        // 03:30 CDT is 08:30 UTC. Converted once, by the component that knows
        // the cabinet's zone, and handed to the agent in round-trip format so
        // it never has to guess at a locale.
        Assert.Equal(
            new DateTimeOffset(2026, 3, 8, 8, 30, 0, TimeSpan.Zero),
            DateTimeOffset.Parse(fine.Value![ActionParameterKeys.ScheduledForUtc]));

        // The rep's own words survive beside it, so the audit record says what
        // was agreed with the clinic rather than only what it became.
        Assert.Equal("2026-03-08T03:30:00", fine.Value[ActionParameterKeys.ScheduledForLocal]);
    }

    [Fact]
    public void The_same_local_hour_converts_to_different_instants_on_either_side_of_a_transition()
    {
        // The other half of the transition, and the reason the contract carries
        // local time at all. "03:30, Sunday" is one thing to a clinic and two
        // different UTC instants to a server, an hour apart. A console that
        // converted once and cached, or a contract that only ever carried UTC,
        // would put one of them an hour wrong.
        var validator = new ActionParameterValidator(
            new ServiceAllowList(Options.Create(new ServiceAllowListOptions())));

        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.ScheduleUpdates);
        Cabinet chicago = In("America/Chicago");
        CabinetClock clock = Clock();

        var nowUtc = new DateTimeOffset(2026, 3, 1, 0, 0, 0, TimeSpan.Zero);

        DateTimeOffset Convert(string local) => DateTimeOffset.Parse(
            validator.Validate(
                entry,
                new Dictionary<string, string> { [ActionParameterKeys.ScheduledForLocal] = local },
                nowUtc,
                chicago,
                clock).Value![ActionParameterKeys.ScheduledForUtc]);

        // 7 March, still CST (UTC-6).
        Assert.Equal(new DateTimeOffset(2026, 3, 7, 9, 30, 0, TimeSpan.Zero), Convert("2026-03-07T03:30:00"));

        // 9 March, now CDT (UTC-5). Same local hour, an hour earlier in UTC.
        Assert.Equal(new DateTimeOffset(2026, 3, 9, 8, 30, 0, TimeSpan.Zero), Convert("2026-03-09T03:30:00"));
    }

    [Fact]
    public void A_caller_cannot_supply_the_UTC_instant_the_server_derives()
    {
        // Same rule as the resolved probe address: a value the server computes
        // is not a value a caller gets to assert. Accepting one here would let
        // a console bypass the daylight-saving check entirely.
        var validator = new ActionParameterValidator(
            new ServiceAllowList(Options.Create(new ServiceAllowListOptions())));

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            ActionCatalog.Get(ActionName.ScheduleUpdates),
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ScheduledForLocal] = "2026-06-08T03:30:00",
                [ActionParameterKeys.ScheduledForUtc] = "2026-06-08T08:30:00Z",
            },
            new DateTimeOffset(2026, 3, 1, 0, 0, 0, TimeSpan.Zero),
            In("America/Chicago"),
            Clock());

        Assert.False(result.Succeeded);
        Assert.Contains("may not be supplied", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void An_install_already_past_at_the_cabinet_is_refused()
    {
        // "In the future" is judged at the cabinet, not at the server. A
        // cabinet twelve hours ahead has already had this morning.
        var validator = new ActionParameterValidator(
            new ServiceAllowList(Options.Create(new ServiceAllowListOptions())));

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            ActionCatalog.Get(ActionName.ScheduleUpdates),
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ScheduledForLocal] = "2026-06-08T03:30:00",
            },
            new DateTimeOffset(2026, 6, 9, 0, 0, 0, TimeSpan.Zero),
            In("America/Chicago"),
            Clock());

        Assert.False(result.Succeeded);
        Assert.Contains("already passed", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void An_install_cannot_be_scheduled_against_a_cabinet_whose_zone_is_unknown()
    {
        // Ruling 16 asks for installs in cabinet-local time. A cabinet that has
        // not reported a zone this host can resolve has no local time to
        // schedule against, and guessing one would put the install an arbitrary
        // number of hours from where the rep meant it.
        var validator = new ActionParameterValidator(
            new ServiceAllowList(Options.Create(new ServiceAllowListOptions())));

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            ActionCatalog.Get(ActionName.ScheduleUpdates),
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ScheduledForLocal] = "2026-03-08T03:30:00",
            },
            new DateTimeOffset(2026, 3, 1, 0, 0, 0, TimeSpan.Zero),
            In("Mars/Olympus_Mons"),
            Clock());

        Assert.False(result.Succeeded);
        Assert.Contains("time zone", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }
}

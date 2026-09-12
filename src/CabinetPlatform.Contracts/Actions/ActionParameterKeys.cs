namespace CabinetPlatform.Contracts.Actions;

/// <summary>
/// Every named operand an action can carry, spelled once.
/// </summary>
/// <remarks>
/// <para>
/// These live in the shared contract rather than being written out on each
/// side because the two sides had drifted. The server's catalog allowed
/// <c>serviceName</c> while the agent read <c>ServiceName</c> from a
/// case-sensitive dictionary; the server sent <c>delaySeconds</c> for a reboot
/// while the agent permitted only a supervisor-override key that no longer
/// existed. Neither failure is visible in a build, a type check or a unit test
/// of either half: the request simply arrives and the agent declines it.
/// </para>
/// <para>
/// Two of these are set by the server after validation rather than supplied by
/// a caller — <see cref="ScheduledForUtc"/> and
/// <see cref="ResolvedTargetAddress"/>. A request that arrives already carrying
/// one is refused, because that value would then be the caller's choice rather
/// than the server's, and the whole point of both is that the server decides.
/// </para>
/// <para>
/// There is no key here for a command, a script, a path or an argument list,
/// and there will not be one. Where an action names a target it names a
/// catalogued thing — a service on an allow-list, a port on an allow-list,
/// another cabinet by identifier.
/// </para>
/// </remarks>
public static class ActionParameterKeys
{
    /// <summary>Which Windows service a service action operates on.</summary>
    /// <remarks>Checked against the server's service allow-list before dispatch.</remarks>
    public const string ServiceName = "serviceName";

    /// <summary>
    /// When an update install should run, in the cabinet's own local time.
    /// </summary>
    /// <remarks>
    /// Local rather than UTC because that is what a rep and a clinic actually
    /// agree on: "Tuesday at 2am" means 2am at the cabinet. The server converts
    /// it, which is also the only place the conversion can be checked — a local
    /// time that does not exist because the zone springs forward that morning
    /// is refused here, and would be undetectable once converted.
    /// </remarks>
    public const string ScheduledForLocal = "scheduledForLocal";

    /// <summary>
    /// The install instant in UTC, derived by the server from
    /// <see cref="ScheduledForLocal"/>. Never supplied by a caller.
    /// </summary>
    public const string ScheduledForUtc = "scheduledForUtc";

    /// <summary>Whether an update install may restart the cabinet when it needs to.</summary>
    public const string RebootIfRequired = "rebootIfRequired";

    /// <summary>How long a reboot warns the machine's users before restarting.</summary>
    public const string DelaySeconds = "delaySeconds";

    /// <summary>Whether a diagnostic bundle includes event log extracts.</summary>
    public const string IncludeEventLogs = "includeEventLogs";

    /// <summary>How far back a collection window reaches, in hours.</summary>
    public const string HoursOfHistory = "hoursOfHistory";

    /// <summary>Which Windows log to read.</summary>
    public const string LogName = "logName";

    /// <summary>The least severe record worth returning.</summary>
    public const string MinimumLevel = "minimumLevel";

    /// <summary>A ceiling on how many records a collection returns.</summary>
    public const string MaxEntries = "maxEntries";

    /// <summary>The cabinet a diagnostic probe targets, by identifier.</summary>
    /// <remarks>
    /// A rep selects a cabinet. There is deliberately no host or address key
    /// for a caller to supply.
    /// </remarks>
    public const string TargetCabinetId = "targetCabinetId";

    /// <summary>
    /// The target's address, resolved by the server from that cabinet's last
    /// reported adapter. Never supplied by a caller.
    /// </summary>
    public const string ResolvedTargetAddress = "resolvedTargetAddress";

    /// <summary>Which port a connectivity test opens, from the server's allow-list.</summary>
    public const string Port = "port";

    /// <summary>Whether a probe may target a cabinet at a different site of the same client.</summary>
    public const string AllowCrossSite = "allowCrossSite";
}

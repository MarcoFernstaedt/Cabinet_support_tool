using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Actions;

/// <summary>
/// The complete catalog of actions an agent can perform. This enum
/// <em>is</em> the allow-list.
/// </summary>
/// <remarks>
/// <para>
/// Actions are named, never described. Because the wire type is an
/// enumeration rather than a string, an action outside this list cannot be
/// represented in a request at all: there is no command line, script body or
/// SQL text anywhere in this contract for one to travel in. Deserialising an
/// unrecognised name fails rather than producing a value.
/// </para>
/// <para>
/// Nothing here actuates cabinet hardware. There is no drawer open, no lock
/// release and no cubie open in this build, by design and not by omission.
/// </para>
/// <para>
/// The zero value is intentionally unused so that a default-initialised or
/// absent value can never be mistaken for a real action.
/// </para>
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ActionName
{
    /// <summary>Ask Windows Update to scan for applicable updates. Non-disruptive.</summary>
    ScanForUpdates = 1,

    /// <summary>Schedule detected updates for installation inside the machine's maintenance window.</summary>
    ScheduleUpdates = 2,

    /// <summary>Collect a diagnostic bundle of logs and configuration for support review.</summary>
    CollectDiagnosticBundle = 3,

    /// <summary>Flush the machine's DNS resolver cache.</summary>
    FlushDnsCache = 4,

    /// <summary>Release and renew the DHCP lease. Briefly interrupts connectivity.</summary>
    RenewDhcpLease = 5,

    /// <summary>Restart a named Windows service.</summary>
    RestartService = 6,

    /// <summary>Start a named Windows service.</summary>
    StartService = 7,

    /// <summary>Stop a named Windows service.</summary>
    StopService = 8,

    /// <summary>
    /// Reboot the cabinet PC. Disruptive: requires a second person's approval
    /// and is gated on <see cref="Telemetry.SystemInfo.AnyUserLoggedOn"/>.
    /// </summary>
    RebootMachine = 9,
}

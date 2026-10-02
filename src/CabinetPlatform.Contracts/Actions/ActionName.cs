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

    /// <summary>
    /// Collect a window of Windows event log records and return them with the
    /// result. Event logs are never part of a routine check-in: at seven
    /// thousand cabinets they would dominate storage while being read for a
    /// handful of them.
    /// </summary>
    CollectEventLogs = 10,

    /// <summary>
    /// Read the current process list and return it with the result, outside
    /// the normal check-in cadence. On demand only, for the same reason as
    /// <see cref="CollectEventLogs"/>.
    /// </summary>
    /// <remarks>
    /// Spelled <c>CollectProcessList</c> in earlier builds. The stored value is
    /// an integer, so renaming the member renames what travels on the wire and
    /// leaves every audit row and action request already in the database
    /// pointing at the same action.
    /// </remarks>
    GetProcessList = 11,

    /// <summary>
    /// Ping another cabinet at the same site, from this cabinet. The target is
    /// named as a cabinet id; the server resolves its last-known local address
    /// and the console never supplies one. Non-disruptive.
    /// </summary>
    PingCabinet = 12,

    /// <summary>
    /// Open a TCP connection from this cabinet to a port on another cabinet at
    /// the same site, to tell a dead host from a blocked port. The port comes
    /// from a server-side allow-list of the ports the CUBEX stack uses.
    /// </summary>
    TestCabinetPort = 13,

    /// <summary>
    /// Trace the network path from this cabinet to another cabinet at the same
    /// site, to locate where a site network fault sits.
    /// </summary>
    TraceRouteToCabinet = 14,

    /// <summary>
    /// End only one selected process after checking its PID, exact creation FILETIME,
    /// observed full image path and image name through one retained Windows handle.
    /// </summary>
    /// <remarks>
    /// PID and name alone are insufficient because a same-name replacement can reuse
    /// the PID. A missing or changed identity is refused; descendants are not terminated.
    /// This historical mutation remains excluded from the monitoring release composition.
    /// </remarks>
    KillProcess = 15,

    /// <summary>
    /// End every process running under one image name, drawn from the
    /// server-side process allow-list. Approval required.
    /// </summary>
    KillProcessByName = 16,

    /// <summary>
    /// Stop an allow-listed application and start it again from its registered
    /// install path. Approval required.
    /// </summary>
    /// <remarks>
    /// The install path is the agent's own registered value for that
    /// application. It is never supplied in the request: a path parameter would
    /// be a command line wearing a different hat.
    /// </remarks>
    RestartApplication = 17,

    /// <summary>
    /// Run one server-defined event log view on the cabinet and return the
    /// matching records.
    /// </summary>
    /// <remarks>
    /// The agent receives the view's fields — log names, sources, event ids,
    /// minimum level, window — and builds the XPath itself. No user-supplied
    /// XPath ever reaches it.
    /// </remarks>
    RunEventLogView = 18,

    /// <summary>
    /// Install specific updates now. Disruptive, approval required, and blocked
    /// while anybody is signed in at the cabinet.
    /// </summary>
    InstallUpdatesNow = 19,

    /// <summary>Withdraw a pending scheduled install. Non-disruptive.</summary>
    CancelScheduledUpdates = 20,

    /// <summary>Read what is currently scheduled to install, and when.</summary>
    GetScheduledUpdates = 21,

    /// <summary>
    /// Change a service's start type, from the server-side service allow-list.
    /// Approval required: a service left disabled does not come back at the
    /// next reboot.
    /// </summary>
    SetServiceStartType = 22,

    /// <summary>
    /// Replace an adapter's DNS servers. Disruptive, approval required, and
    /// applied under confirm-or-revert.
    /// </summary>
    SetDnsServers = 23,

    /// <summary>
    /// Give an adapter a static address. Disruptive, approval required, and
    /// applied under confirm-or-revert.
    /// </summary>
    SetStaticIpAddress = 24,

    /// <summary>
    /// Return an adapter to DHCP. Disruptive, approval required, and applied
    /// under confirm-or-revert.
    /// </summary>
    SetAdapterToDhcp = 25,

    /// <summary>Ping a host from this cabinet. Non-disruptive.</summary>
    PingHost = 26,

    /// <summary>Trace the network path from this cabinet to a host.</summary>
    TraceRoute = 27,

    /// <summary>
    /// Open a TCP connection from this cabinet to a host and port, to tell a
    /// dead host from a blocked port.
    /// </summary>
    TestPortConnectivity = 28,

    /// <summary>Read bounded Windows Defender Firewall profile and rule metadata. Changes nothing.</summary>
    InspectFirewall = 29,

    /// <summary>Observe bounded OS display modes visible to the service without changing settings.</summary>
    GetDisplayDiagnostics = 30,

    /// <summary>Read bounded, allowlisted Windows Error Reporting store metadata only.</summary>
    GetWerMetadata = 31,

    /// <summary>
    /// Reserved. Opening a drawer is hardware actuation, which this build does
    /// not perform.
    /// </summary>
    /// <remarks>
    /// The value exists so that the permission, the audit event and the refusal
    /// are all real and exercised. There is no executor for it on any agent and
    /// the server answers every request for it with a denial and an audit row.
    /// Do not implement it here; actuation is a separate, on-site decision with
    /// its own safety case.
    /// </remarks>
    OpenDrawer = 900,

    /// <summary>Reserved. Releasing a lock is hardware actuation. Always denied.</summary>
    UnlockLock = 901,

    /// <summary>Reserved. Opening a cubie is hardware actuation. Always denied.</summary>
    OpenCubie = 902,
}

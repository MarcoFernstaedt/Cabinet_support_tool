namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// The root object an agent sends to the server on every check-in.
/// </summary>
/// <remarks>
/// <para>
/// Every section is optional and independently nullable. A collector that
/// fails records its reason in <see cref="SectionErrors"/> and leaves its
/// section <see langword="null"/>, so a single failing collector never costs
/// the whole payload.
/// </para>
/// <para>
/// A <see langword="null"/> section means "not collected"; it never means
/// "collected and empty". An empty list means the machine genuinely has none
/// of that thing.
/// </para>
/// </remarks>
public sealed record CheckInPayload
{
    /// <summary>Version of the agent that produced this payload.</summary>
    public required string AgentVersion { get; init; }

    /// <summary>
    /// Cabinet this machine has been assigned to, or <see langword="null"/>
    /// while the agent is still pending Supervisor approval. An unapproved
    /// agent has no cabinet identity and its data is not usable as cabinet
    /// telemetry.
    /// </summary>
    public Guid? CabinetId { get; init; }

    /// <summary>
    /// Stable hardware-derived machine identifier, hashed. This — never the
    /// hostname — is how a physical machine is recognised across renames,
    /// re-imaging and network changes.
    /// </summary>
    public required string MachineId { get; init; }

    /// <summary>UTC instant at which the agent finished assembling this payload.</summary>
    public required DateTimeOffset CollectedAtUtc { get; init; }

    /// <summary>Operating system and identity facts, or <see langword="null"/> if the section failed.</summary>
    public SystemInfo? System { get; init; }

    /// <summary>CPU, memory and process counters, or <see langword="null"/> if the section failed.</summary>
    public PerformanceInfo? Performance { get; init; }

    /// <summary>Windows services observed on the machine, or <see langword="null"/> if the section failed.</summary>
    public IReadOnlyList<ServiceInfo>? Services { get; init; }

    /// <summary>Fixed disks and volumes, or <see langword="null"/> if the section failed.</summary>
    public IReadOnlyList<DiskInfo>? Disks { get; init; }

    /// <summary>Selected event log entries, or <see langword="null"/> if the section failed.</summary>
    public IReadOnlyList<EventLogEntry>? EventLogs { get; init; }

    /// <summary>Windows Update state, or <see langword="null"/> if the section failed.</summary>
    public WindowsUpdateInfo? WindowsUpdate { get; init; }

    /// <summary>Adapters, firewall profiles and server reachability, or <see langword="null"/> if the section failed.</summary>
    public NetworkInfo? Network { get; init; }

    /// <summary>
    /// Reserved for cabinet hardware telemetry (sensors, drawers). Sensor and
    /// drawer discovery is incomplete, so this is always
    /// <see langword="null"/> in this build. It is deliberately untyped: the
    /// shape is not designed yet and must not be guessed at, and it must never
    /// be populated with placeholder data.
    /// </summary>
    public object? CabinetData { get; init; }

    /// <summary>
    /// Outcomes of update installs this platform asked for, reported once the
    /// machine has actually carried them out.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Scheduling an install and installing one are different facts. The
    /// scheduling is known the moment the action is dispatched; what the
    /// machine did with it is only known afterwards, and may be a failure, a
    /// rollback or a superseded package. A fleet that treats the first as the
    /// second believes it is patched when it is not.
    /// </para>
    /// <para>
    /// The agent carries an outcome here until the server has acknowledged the
    /// check-in that reported it, so an install whose report was lost to an
    /// outage is still reported afterwards rather than silently forgotten.
    /// </para>
    /// </remarks>
    public IReadOnlyList<UpdateInstallOutcome>? UpdateInstallOutcomes { get; init; }

    /// <summary>
    /// Section name to failure reason for every collector that could not
    /// complete, so a partial payload explains its own gaps. Empty when every
    /// collector succeeded.
    /// </summary>
    public IReadOnlyDictionary<string, string> SectionErrors { get; init; }
        = new Dictionary<string, string>();
}

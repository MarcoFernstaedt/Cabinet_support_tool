namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// Identity, operating system and logon facts about the cabinet PC.
/// </summary>
/// <remarks>
/// Every member is nullable: a value that could not be read is
/// <see langword="null"/> and is never substituted with a default. This
/// matters most for <see cref="AnyUserLoggedOn"/>, which gates reboots.
/// </remarks>
public sealed record SystemInfo
{
    /// <summary>
    /// Machine hostname, for display only. Hostnames change; cabinets are
    /// identified by <see cref="CheckInPayload.MachineId"/>.
    /// </summary>
    public string? Hostname { get; init; }

    /// <summary>Operating system product name and version, as reported by Windows.</summary>
    public string? OsVersion { get; init; }

    /// <summary>Operating system build number, for example "19045.4780".</summary>
    public string? OsBuild { get; init; }

    /// <summary>UTC instant the operating system was installed.</summary>
    public DateTimeOffset? InstallDateUtc { get; init; }

    /// <summary>UTC instant of the last boot.</summary>
    public DateTimeOffset? LastBootUtc { get; init; }

    /// <summary>Time elapsed since the last boot.</summary>
    public TimeSpan? Uptime { get; init; }

    /// <summary>IANA or Windows time zone identifier the machine is configured for.</summary>
    public string? TimeZoneId { get; init; }

    /// <summary>
    /// The machine's own clock at collection time, in UTC. Compared against
    /// the server clock this exposes drift, which breaks chain-of-custody
    /// ordering if left uncorrected.
    /// </summary>
    public DateTimeOffset? SystemTimeUtc { get; init; }

    /// <summary>Domain or workgroup name the machine belongs to.</summary>
    public string? DomainOrWorkgroup { get; init; }

    /// <summary>Whether the machine is joined to a domain, or <see langword="null"/> if unknown.</summary>
    public bool? IsDomainJoined { get; init; }

    /// <summary>
    /// Whether any interactive user session is currently logged on. This is
    /// the safety gate for whether a reboot may be permitted: a clinician may
    /// be mid-dispense. <see langword="null"/> means the agent could not
    /// determine it, which is not the same as "nobody is logged on" and must
    /// be treated as unsafe to reboot.
    /// </summary>
    public bool? AnyUserLoggedOn { get; init; }

    /// <summary>Number of interactive sessions logged on, or <see langword="null"/> if unknown.</summary>
    public int? LoggedOnUserCount { get; init; }

    /// <summary>Installed software inventory, or <see langword="null"/> if it could not be enumerated.</summary>
    public IReadOnlyList<InstalledSoftwareInfo>? InstalledSoftware { get; init; }
}

/// <summary>
/// One entry from the machine's installed software inventory.
/// </summary>
public sealed record InstalledSoftwareInfo
{
    /// <summary>Display name of the installed product.</summary>
    public required string Name { get; init; }

    /// <summary>Product version string, or <see langword="null"/> if the product does not report one.</summary>
    public string? Version { get; init; }

    /// <summary>Publisher, or <see langword="null"/> if the product does not report one.</summary>
    public string? Publisher { get; init; }

    /// <summary>Installation date, or <see langword="null"/> if the product does not record one.</summary>
    public DateTimeOffset? InstallDate { get; init; }
}

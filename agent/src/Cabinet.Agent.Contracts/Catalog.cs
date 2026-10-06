namespace Cabinet.Agent.Contracts;

public enum OperationKind { Read, Write }

public enum RateClass { Read, Write, NetworkTest }

/// <summary>One entry in the compiled-in operation catalog.</summary>
public sealed record CatalogEntry(string Name, OperationKind Kind, string MinimumRole, bool StepUp, int ExpirySeconds, RateClass RateClass, bool SafetyNet, Type ParamsType, Type OutputType);

/// <summary>
/// The fixed operation catalog (docs/spec/04-agent-spec.md, contracts/schemas/operations/catalog.json).
/// The agent accepts these names and nothing else. Adding one requires a
/// signed agent upgrade; the server cannot extend it.
/// </summary>
public static class Catalog
{
    public const string SystemInfo = "system.info";
    public const string EventlogChannels = "eventlog.channels";
    public const string EventlogQuery = "eventlog.query";
    public const string EventlogGet = "eventlog.get";
    public const string DevicesList = "devices.list";
    public const string DriversList = "drivers.list";
    public const string PeripheralStatus = "peripheral.status";
    public const string UpdatesStatus = "updates.status";
    public const string DiskSmart = "disk.smart";
    public const string FilesList = "files.list";
    public const string NetworkConfig = "network.config";
    public const string NetworkTest = "network.test";
    public const string FirewallState = "firewall.state";
    public const string NetworkSetIp = "network.setIp";
    public const string NetworkSetDns = "network.setDns";
    public const string FirewallSetProfile = "firewall.setProfile";
    public const string FirewallSetRule = "firewall.setRule";
    public const string FirewallRestore = "firewall.restore";
    public const string PackageInstall = "package.install";
    public const string DriverUninstall = "driver.uninstall";

    private static CatalogEntry Read<TParams, TOutput>(string name, RateClass rate = RateClass.Read) =>
        new(name, OperationKind.Read, "tier1", StepUp: false, ExpirySeconds: 300, rate, SafetyNet: false, typeof(TParams), typeof(TOutput));

    private static CatalogEntry Write<TParams, TOutput>(string name, bool safetyNet) =>
        new(name, OperationKind.Write, "tier2", StepUp: true, ExpirySeconds: 120, RateClass.Write, safetyNet, typeof(TParams), typeof(TOutput));

    public static IReadOnlyList<CatalogEntry> All { get; } = new[]
    {
        Read<EmptyParams, SystemInfoOutput>(SystemInfo),
        Read<EmptyParams, EventlogChannelsOutput>(EventlogChannels),
        Read<EventlogQueryParams, EventlogQueryOutput>(EventlogQuery),
        Read<EventlogGetParams, EventlogGetOutput>(EventlogGet),
        Read<DevicesListParams, DevicesListOutput>(DevicesList),
        Read<EmptyParams, DriversListOutput>(DriversList),
        Read<EmptyParams, PeripheralStatusOutput>(PeripheralStatus),
        Read<EmptyParams, UpdatesStatusOutput>(UpdatesStatus),
        Read<EmptyParams, DiskSmartOutput>(DiskSmart),
        Read<FilesListParams, FilesListOutput>(FilesList),
        Read<EmptyParams, NetworkConfigOutput>(NetworkConfig),
        Read<NetworkTestParams, NetworkTestOutput>(NetworkTest, RateClass.NetworkTest),
        Read<EmptyParams, FirewallStateOutput>(FirewallState),
        Write<NetworkSetIpParams, NetworkSetIpOutput>(NetworkSetIp, safetyNet: true),
        Write<NetworkSetDnsParams, NetworkSetDnsOutput>(NetworkSetDns, safetyNet: true),
        Write<FirewallSetProfileParams, FirewallSetProfileOutput>(FirewallSetProfile, safetyNet: true),
        Write<FirewallSetRuleParams, FirewallSetRuleOutput>(FirewallSetRule, safetyNet: true),
        Write<FirewallRestoreParams, FirewallRestoreOutput>(FirewallRestore, safetyNet: true),
        Write<PackageInstallParams, PackageInstallOutput>(PackageInstall, safetyNet: false),
        Write<DriverUninstallParams, DriverUninstallOutput>(DriverUninstall, safetyNet: false),
    };

    private static readonly Dictionary<string, CatalogEntry> ByName = All.ToDictionary(e => e.Name, StringComparer.Ordinal);

    /// <summary>Exact, case-sensitive lookup. Unknown names are not operations.</summary>
    public static bool TryGet(string? name, out CatalogEntry entry) =>
        ByName.TryGetValue(name ?? string.Empty, out entry!);

    /// <summary>The event logs the agent may read. The Security log is never in this list.</summary>
    public static IReadOnlyList<string> AllowedLogs { get; } = new[]
    {
        "System", "Application", "Setup",
        "Microsoft-Windows-Kernel-PnP/Configuration",
        "Microsoft-Windows-DriverFrameworks-UserMode/Operational",
        "Microsoft-Windows-Kernel-WHEA/Errors",
        "Microsoft-Windows-Storage-Storport/Operational",
        "Microsoft-Windows-Ntfs/Operational",
        "Microsoft-Windows-NetworkProfile/Operational",
        "Microsoft-Windows-Dhcp-Client/Admin",
        "Microsoft-Windows-DNS-Client/Operational",
        "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall",
        "Microsoft-Windows-WindowsUpdateClient/Operational",
    };

    public static IReadOnlyList<string> RejectionCodes { get; } = new[]
    {
        "unknown_operation", "invalid_params", "expired", "replayed", "wrong_cabinet", "read_only_mode",
        "rate_limited", "hash_mismatch", "signature_invalid", "publisher_not_trusted", "verification_failed",
    };

    public static IReadOnlyList<string> FailureCodes { get; } = new[]
    {
        "execution_failed", "timeout", "not_found", "unavailable", "safety_net_rollback",
    };
}

namespace Cabinet.Agent.Contracts;

public enum OperationKind { Read, Write }

public enum RateClass { Read, Write, NetworkTest, NetworkTrace }

/// <summary>How a person confirms an operation (docs/spec/12-milestones-8-to-12.md): none for reads, a click, or an authenticator code.</summary>
public enum Confirm { None, Click, Code }

/// <summary>One entry in the compiled-in operation catalog.</summary>
public sealed record CatalogEntry(string Name, OperationKind Kind, string MinimumRole, Confirm Confirm, int ExpirySeconds, RateClass RateClass, bool SafetyNet, Type ParamsType, Type OutputType);

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
    public const string NetworkTrace = "network.trace";
    public const string FirewallState = "firewall.state";
    public const string NetworkSetIp = "network.setIp";
    public const string NetworkSetDns = "network.setDns";
    public const string FirewallSetProfile = "firewall.setProfile";
    public const string FirewallApplyPolicy = "firewall.applyPolicy";
    public const string FirewallSetRule = "firewall.setRule";
    public const string FirewallRestore = "firewall.restore";
    public const string PackageInstall = "package.install";
    public const string DriverUninstall = "driver.uninstall";
    public const string UpdatesUninstall = "updates.uninstall";
    public const string ServicesList = "services.list";
    public const string ProcessesList = "processes.list";
    public const string ServiceControl = "service.control";
    public const string TimeStatus = "time.status";
    public const string TimeSetZone = "time.setZone";
    public const string TimeSync = "time.sync";
    public const string SystemPerformance = "system.performance";
    public const string NetworkListeners = "network.listeners";
    public const string NetworkRenewLease = "network.renewLease";

    private static CatalogEntry Read<TParams, TOutput>(string name, RateClass rate = RateClass.Read) =>
        new(name, OperationKind.Read, "tier1", Confirm.None, ExpirySeconds: 300, rate, SafetyNet: false, typeof(TParams), typeof(TOutput));

    private static CatalogEntry Write<TParams, TOutput>(string name, bool safetyNet, Confirm confirm, string minimumRole = "tier2") =>
        new(name, OperationKind.Write, minimumRole, confirm, ExpirySeconds: 120, RateClass.Write, safetyNet, typeof(TParams), typeof(TOutput));

    public static IReadOnlyList<CatalogEntry> All { get; } = new[]
    {
        Read<EmptyParams, SystemInfoOutput>(SystemInfo),
        Read<EmptyParams, EventlogChannelsOutput>(EventlogChannels),
        Read<EventlogQueryParams, EventlogQueryOutput>(EventlogQuery),
        Read<EventlogGetParams, EventlogGetOutput>(EventlogGet),
        Read<DevicesListParams, DevicesListOutput>(DevicesList),
        Read<EmptyParams, DriversListOutput>(DriversList),
        Read<PeripheralStatusParams, PeripheralStatusOutput>(PeripheralStatus),
        Read<EmptyParams, UpdatesStatusOutput>(UpdatesStatus),
        Read<EmptyParams, DiskSmartOutput>(DiskSmart),
        Read<FilesListParams, FilesListOutput>(FilesList),
        Read<EmptyParams, NetworkConfigOutput>(NetworkConfig),
        Read<NetworkTestParams, NetworkTestOutput>(NetworkTest, RateClass.NetworkTest),
        Read<NetworkTraceParams, NetworkTraceOutput>(NetworkTrace, RateClass.NetworkTrace),
        Read<EmptyParams, FirewallStateOutput>(FirewallState),
        Read<EmptyParams, SystemPerformanceOutput>(SystemPerformance),
        Read<EmptyParams, NetworkListenersOutput>(NetworkListeners),
        Read<EmptyParams, ServicesListOutput>(ServicesList),
        Read<EmptyParams, ProcessesListOutput>(ProcessesList),
        Read<EmptyParams, TimeStatusOutput>(TimeStatus),
        Write<NetworkSetIpParams, NetworkSetIpOutput>(NetworkSetIp, safetyNet: true, Confirm.Code),
        Write<NetworkSetDnsParams, NetworkSetDnsOutput>(NetworkSetDns, safetyNet: true, Confirm.Code),
        Write<FirewallSetProfileParams, FirewallSetProfileOutput>(FirewallSetProfile, safetyNet: true, Confirm.Click, "tier1"),
        Write<FirewallApplyPolicyParams, FirewallApplyPolicyOutput>(FirewallApplyPolicy, safetyNet: true, Confirm.Click, "tier1"),
        Write<FirewallSetRuleParams, FirewallSetRuleOutput>(FirewallSetRule, safetyNet: true, Confirm.Click),
        Write<FirewallRestoreParams, FirewallRestoreOutput>(FirewallRestore, safetyNet: true, Confirm.Code),
        Write<PackageInstallParams, PackageInstallOutput>(PackageInstall, safetyNet: false, Confirm.Code),
        Write<DriverUninstallParams, DriverUninstallOutput>(DriverUninstall, safetyNet: false, Confirm.Code),
        Write<UpdatesUninstallParams, UpdatesUninstallOutput>(UpdatesUninstall, safetyNet: false, Confirm.Code),
        Write<ServiceControlParams, ServiceControlOutput>(ServiceControl, safetyNet: false, Confirm.Click),
        Write<TimeSetZoneParams, TimeSetZoneOutput>(TimeSetZone, safetyNet: false, Confirm.Click, "tier1"),
        Write<EmptyParams, TimeSyncOutput>(TimeSync, safetyNet: false, Confirm.Click, "tier1"),
        Write<NetworkRenewLeaseParams, NetworkRenewLeaseOutput>(NetworkRenewLease, safetyNet: false, Confirm.Click, "tier1"),
    };

    private static readonly Dictionary<string, CatalogEntry> ByName = All.ToDictionary(e => e.Name, StringComparer.Ordinal);

    /// <summary>Exact, case-sensitive lookup. Unknown names are not operations.</summary>
    public static bool TryGet(string? name, out CatalogEntry entry) =>
        ByName.TryGetValue(name ?? string.Empty, out entry!);

    /// <summary>The event logs the agent may read. The Security log is never in this list.</summary>
    public static IReadOnlyList<string> AllowedLogs { get; } = new[]
    {
        "System",
        "Application",
        "Setup",
        "HardwareEvents",
        "Microsoft-Windows-Kernel-PnP/Configuration",
        "Microsoft-Windows-Kernel-PnP/Driver Watchdog",
        "Microsoft-Windows-DriverFrameworks-UserMode/Operational",
        "Microsoft-Windows-UserPnp/DeviceInstall",
        "Microsoft-Windows-DeviceSetupManager/Admin",
        "Microsoft-Windows-DeviceSetupManager/Operational",
        "Microsoft-Windows-Biometrics/Operational",
        "Microsoft-Windows-CodeIntegrity/Operational",
        "Microsoft-Windows-Kernel-WHEA/Errors",
        "Microsoft-Windows-Kernel-WHEA/Operational",
        "Microsoft-Windows-Kernel-Power/Thermal-Operational",
        "Microsoft-Windows-Kernel-Boot/Operational",
        "Microsoft-Windows-Kernel-IO/Operational",
        "Microsoft-Windows-Diagnostics-Performance/Operational",
        "Microsoft-Windows-Resource-Exhaustion-Detector/Operational",
        "Microsoft-Windows-Storage-Storport/Operational",
        "Microsoft-Windows-Storage-Storport/Health",
        "Microsoft-Windows-Storage-ClassPnP/Operational",
        "Microsoft-Windows-StorageSpaces-Driver/Operational",
        "Microsoft-Windows-Ntfs/Operational",
        "Microsoft-Windows-Partition/Diagnostic",
        "Microsoft-Windows-NetworkProfile/Operational",
        "Microsoft-Windows-NCSI/Operational",
        "Microsoft-Windows-TCPIP/Operational",
        "Microsoft-Windows-Dhcp-Client/Admin",
        "Microsoft-Windows-Dhcp-Client/Operational",
        "Microsoft-Windows-DNS-Client/Operational",
        "Microsoft-Windows-WLAN-AutoConfig/Operational",
        "Microsoft-Windows-SMBClient/Connectivity",
        "Microsoft-Windows-SMBClient/Operational",
        "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall",
        "Microsoft-Windows-Time-Service/Operational",
        "Microsoft-Windows-WindowsUpdateClient/Operational",
        "Microsoft-Windows-Bits-Client/Operational",
        "Microsoft-Windows-TaskScheduler/Operational",
        "Microsoft-Windows-PrintService/Admin",
        "Microsoft-Windows-Windows Defender/Operational",
        "Microsoft-Windows-GroupPolicy/Operational",
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

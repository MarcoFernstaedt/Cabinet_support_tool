using System.Management;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;
using Microsoft.Win32;

namespace Cabinet.Agent.Windows;

/// <summary>
/// system.hardware, system.identity and network.hosts: read-only. Every source is read on its own, and a source that fails (a missing WMI
/// class, a registry key that is not there, access refused) gives null for just its fields, so one gap never fails the operation. No process
/// is started, no command text is built, and every registry key and WMI query is a constant in this file. The one file read is the hosts
/// file at its fixed Windows location.
/// </summary>
[SupportedOSPlatform("windows")]
public static class HardwareOperations
{
    private const string Tpm = @"root\CIMV2\Security\MicrosoftTpm";
    private const string PortsClassGuid = "{4d36e978-e325-11ce-bfc1-08002be10318}";
    private const string EnumKey = @"SYSTEM\CurrentControlSet\Enum";
    private const string ClassKey = @"SYSTEM\CurrentControlSet\Control\Class";
    private const int MaxEnumKeysVisited = 6000;

    /// <summary>Runs one source; a failure of any ordinary kind gives the fallback instead of an error.</summary>
    private static T Safe<T>(Func<T> read, T fallback)
    {
        try { return read(); }
        catch (Exception e) when (e is not OutOfMemoryException and not OperationCanceledException) { return fallback; }
    }

    /// <summary>A WMI query where "the class does not exist" and "no rows" are different answers: null on failure.</summary>
    private static List<Dictionary<string, object?>>? Query(string scope, string wql, int max) => Safe<List<Dictionary<string, object?>>?>(() => Wmi.Query(scope, wql, max), null);

    // ---- system.hardware ----------------------------------------------------------------------------------------------------------

    public static SystemHardwareOutput Hardware()
    {
        var now = DateTimeOffset.UtcNow;
        var system = Query(Wmi.CimV2, "SELECT Manufacturer, Model, TotalPhysicalMemory FROM Win32_ComputerSystem", 1)?.FirstOrDefault();
        var bios = Query(Wmi.CimV2, "SELECT Manufacturer, SMBIOSBIOSVersion, ReleaseDate FROM Win32_BIOS", 1)?.FirstOrDefault();
        var processors = Query(Wmi.CimV2, "SELECT Name, NumberOfLogicalProcessors FROM Win32_Processor", 8);
        var modules = Query(Wmi.CimV2, "SELECT DeviceLocator, Capacity, ConfiguredClockSpeed, Speed FROM Win32_PhysicalMemory", 256);
        var os = Query(Wmi.CimV2, "SELECT LastBootUpTime FROM Win32_OperatingSystem", 1)?.FirstOrDefault();

        long? logical = processors is { Count: > 0 } ? processors.Sum(p => p.Long("NumberOfLogicalProcessors") ?? 0) : null;
        if (logical is null or 0) logical = Environment.ProcessorCount;
        long? installed = modules is { Count: > 0 } && modules.All(m => m.Long("Capacity") > 0) ? modules.Sum(m => m.Long("Capacity")!.Value) : null;

        return new SystemHardwareOutput
        {
            TakenAt = now,
            Manufacturer = InventoryRules.Clean(system?.Text("Manufacturer"), 200),
            Model = InventoryRules.Clean(system?.Text("Model"), 200),
            Bios = new BiosInfo
            {
                Vendor = InventoryRules.Clean(bios?.Text("Manufacturer"), 200),
                Version = InventoryRules.Clean(bios?.Text("SMBIOSBIOSVersion"), 200),
                Date = bios?.Date("ReleaseDate"),
            },
            Cpu = new CpuInfo { Model = InventoryRules.Clean(processors?.FirstOrDefault()?.Text("Name"), 200), LogicalCores = logical },
            Memory = new MemoryInfo
            {
                TotalBytes = installed ?? system?.Long("TotalPhysicalMemory"),
                ModuleCount = modules?.Count,
                Modules = (modules ?? []).Take(HardwareRules.MaxModules).Select(m => new MemoryModule
                {
                    Slot = InventoryRules.Clean(m.Text("DeviceLocator"), 100),
                    CapacityBytes = m.Long("Capacity") is > 0 and var c ? c : null,
                    SpeedMhz = (m.Long("ConfiguredClockSpeed") is > 0 and var s ? s : m.Long("Speed") is > 0 and var s2 ? s2 : null),
                }).ToList(),
            },
            Tpm = TpmState(),
            SecureBoot = Safe(SecureBoot, null),
            LastBoot = os?.Date("LastBootUpTime") ?? Safe<DateTimeOffset?>(() => now - TimeSpan.FromMilliseconds(Environment.TickCount64), null),
            Monitors = Safe(Monitors, new List<MonitorInfo>()),
            Ports = Safe(SerialPorts, new List<SerialPortInfo>()),
        };
    }

    /// <summary>Null when the TPM service cannot be asked at all; "present false" when it answers with no TPM.</summary>
    private static TpmInfo? TpmState()
    {
        var rows = Query(Tpm, "SELECT IsEnabled_InitialValue, SpecVersion FROM Win32_Tpm", 1);
        if (rows is null) return null;
        if (rows.Count == 0) return new TpmInfo { Present = false, Enabled = null, Version = null };
        return new TpmInfo { Present = true, Enabled = rows[0].Bool("IsEnabled_InitialValue"), Version = HardwareRules.TpmVersion(rows[0].Text("SpecVersion")) };
    }

    private static SecureBootState? SecureBoot()
    {
        using RegistryKey? state = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\SecureBoot\State");
        return HardwareRules.SecureBootFor(state is not null, state?.GetValue("UEFISecureBootEnabled"));
    }

    /// <summary>
    /// The displays Windows has connected now (WMI lists only active ones), each with the name and native resolution from its EDID in the
    /// registry. The service has no desktop, so the resolution set in a user's session is not available; the native one is reported.
    /// </summary>
    private static List<MonitorInfo> Monitors()
    {
        var found = new List<MonitorInfo>();
        foreach (var row in Wmi.Query(Wmi.RootWmi, "SELECT InstanceName, UserFriendlyName FROM WmiMonitorID", HardwareRules.MaxMonitors))
        {
            string? path = HardwareRules.MonitorEnumPath(row.Text("InstanceName"));
            (string? name, long? width, long? height) = (null, null, null);
            if (path is not null)
            {
                using RegistryKey? parameters = Registry.LocalMachine.OpenSubKey($@"{EnumKey}\{path}\Device Parameters");
                (name, width, height) = HardwareRules.ParseEdid(parameters?.GetValue("EDID") as byte[]);
            }
            found.Add(new MonitorInfo
            {
                Name = HardwareRules.TextFromNumbers(row.TryGetValue("UserFriendlyName", out object? n) ? n : null) ?? name,
                Width = width,
                Height = height,
            });
        }
        return found;
    }

    /// <summary>
    /// The serial ports Windows has open now (HKLM\HARDWARE\DEVICEMAP\SERIALCOMM), each matched to its device by the PortName its Plug and
    /// Play entry holds, with the driver provider and version from the port class. The walk of the device tree is bounded.
    /// </summary>
    private static List<SerialPortInfo> SerialPorts()
    {
        var names = new List<string>();
        using (RegistryKey? map = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DEVICEMAP\SERIALCOMM"))
            foreach (string value in map?.GetValueNames() ?? [])
                if (map!.GetValue(value) is string port && HardwareRules.IsComPortName(port.Trim()) && !names.Contains(port.Trim().ToUpperInvariant()))
                    names.Add(port.Trim().ToUpperInvariant());
        names = names.OrderBy(HardwareRules.ComNumber).Take(HardwareRules.MaxPorts).ToList();
        if (names.Count == 0) return [];

        var details = PortDevices(names);
        return names.Select(p => details.TryGetValue(p, out var d) ? d : new SerialPortInfo { Port = p, DeviceName = null, DriverProvider = null, DriverVersion = null }).ToList();
    }

    private static Dictionary<string, SerialPortInfo> PortDevices(List<string> names)
    {
        var details = new Dictionary<string, SerialPortInfo>();
        int visited = 0;
        using RegistryKey? enumRoot = Registry.LocalMachine.OpenSubKey(EnumKey);
        foreach (string bus in enumRoot?.GetSubKeyNames() ?? [])
        {
            using RegistryKey? busKey = enumRoot!.OpenSubKey(bus);
            foreach (string device in busKey?.GetSubKeyNames() ?? [])
            {
                using RegistryKey? deviceKey = busKey!.OpenSubKey(device);
                foreach (string instance in deviceKey?.GetSubKeyNames() ?? [])
                {
                    if (++visited > MaxEnumKeysVisited) return details;
                    using RegistryKey? key = deviceKey!.OpenSubKey(instance);
                    if (key is null || !string.Equals(key.GetValue("ClassGUID") as string, PortsClassGuid, StringComparison.OrdinalIgnoreCase)) continue;
                    using RegistryKey? parameters = key.OpenSubKey("Device Parameters");
                    if (parameters?.GetValue("PortName") is not string portName || !names.Contains(portName.Trim().ToUpperInvariant())) continue;
                    string port = portName.Trim().ToUpperInvariant();
                    if (details.ContainsKey(port)) continue;
                    string? provider = null, version = null;
                    if (HardwareRules.DriverKeyFor(key.GetValue("Driver") as string, PortsClassGuid) is { } index)
                    {
                        using RegistryKey? driver = Registry.LocalMachine.OpenSubKey($@"{ClassKey}\{PortsClassGuid}\{index}");
                        provider = InventoryRules.Clean(driver?.GetValue("ProviderName") as string, 120);
                        version = InventoryRules.Clean(driver?.GetValue("DriverVersion") as string, 60);
                    }
                    details[port] = new SerialPortInfo
                    {
                        Port = port,
                        DeviceName = HardwareRules.DeviceText(key.GetValue("FriendlyName") as string) ?? HardwareRules.DeviceText(key.GetValue("DeviceDesc") as string),
                        DriverProvider = provider,
                        DriverVersion = version,
                    };
                }
            }
        }
        return details;
    }

    // ---- network.hosts ------------------------------------------------------------------------------------------------------------

    /// <summary>The hosts file at %SystemRoot%\System32\drivers\etc\hosts, and nothing else: the path is built here from the system directory.</summary>
    public static NetworkHostsOutput Hosts()
    {
        string path = Path.Combine(Environment.SystemDirectory, "drivers", "etc", "hosts");
        string text;
        bool cut = false;
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists) return new NetworkHostsOutput { TakenAt = DateTimeOffset.UtcNow, Entries = [], Truncated = false };
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new OperationFailedException("unavailable", "The hosts file is a link, which this reading does not follow.");
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.SequentialScan);
            var buffer = new byte[HardwareRules.MaxHostsFileBytes + 1];
            int length = 0, read;
            while (length < buffer.Length && (read = stream.Read(buffer, length, buffer.Length - length)) > 0) length += read;
            cut = length > HardwareRules.MaxHostsFileBytes;
            text = HardwareRules.DecodeHosts(buffer.AsSpan(0, Math.Min(length, HardwareRules.MaxHostsFileBytes)));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new OperationFailedException("execution_failed", "Windows would not let the agent read the hosts file.");
        }
        var (entries, truncated) = HardwareRules.ParseHosts(text);
        return new NetworkHostsOutput { TakenAt = DateTimeOffset.UtcNow, Entries = entries, Truncated = truncated || cut };
    }

    // ---- system.identity ----------------------------------------------------------------------------------------------------------

    private const string Winlogon = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
    private const string GroupPolicyMachine = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\State\Machine";

    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern int NetGetJoinInformation(string? server, out IntPtr name, out int status);
    [DllImport("netapi32.dll")] private static extern int NetApiBufferFree(IntPtr buffer);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern int NetLocalGroupGetMembers(string? server, string group, int level, out IntPtr buffer, int preferredMax, out int read, out int total, ref IntPtr resume);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern int DsGetDcNameW(string? computer, string? domain, IntPtr guid, string? site, uint flags, out IntPtr info);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct LocalGroupMemberInfo3 { public IntPtr DomainAndName; }

    /// <summary>
    /// Run by the network process: it needs no administrator rights, and finding a domain controller is a network lookup, which the broker
    /// never does. Nothing here reads a password: of the sign-in settings only the on/off flag and the user name are opened.
    /// </summary>
    public static SystemIdentityOutput Identity()
    {
        (JoinType join, string? name) = Safe(JoinState, (JoinType.Unknown, (string?)null));
        return new SystemIdentityOutput
        {
            TakenAt = DateTimeOffset.UtcNow,
            JoinType = join,
            Name = name,
            DomainControllerFound = join == JoinType.Domain && name is not null ? DomainControllerFound(name) : null,
            LocalAdministrators = Safe(Administrators, null),
            AutoLogon = Safe(AutoLogon, null),
            GroupPolicyLastApplied = Safe(GroupPolicyTime, null),
        };
    }

    private static (JoinType, string?) JoinState()
    {
        int result = NetGetJoinInformation(null, out IntPtr buffer, out int status);
        if (result != 0) return (JoinType.Unknown, null);
        try { return (HardwareRules.JoinTypeFor(status), status is 2 or 3 ? InventoryRules.Clean(Marshal.PtrToStringUni(buffer), 200) : null); }
        finally { NetApiBufferFree(buffer); }
    }

    /// <summary>True when Windows finds a domain controller now (DS_FORCE_REDISCOVERY), false when it does not, null when the lookup takes too long.</summary>
    private static bool? DomainControllerFound(string domain)
    {
        var lookup = Task.Run(() =>
        {
            int result = DsGetDcNameW(null, domain, IntPtr.Zero, null, 0x1, out IntPtr info);
            if (result == 0) NetApiBufferFree(info);
            return result == 0;
        });
        return Safe<bool?>(() => lookup.Wait(TimeSpan.FromSeconds(12)) ? lookup.Result : null, null);
    }

    /// <summary>The members of the local Administrators group, found by its well-known identifier so a translated group name works. Names only.</summary>
    private static LocalAdministrators? Administrators()
    {
        string account = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null).Translate(typeof(NTAccount)).Value;
        string group = account[(account.LastIndexOf('\\') + 1)..];
        IntPtr resume = IntPtr.Zero;
        if (NetLocalGroupGetMembers(null, group, 3, out IntPtr buffer, -1, out int read, out int total, ref resume) != 0) return null;
        try
        {
            var names = new List<string>();
            int size = Marshal.SizeOf<LocalGroupMemberInfo3>();
            for (int i = 0; i < Math.Min(read, 1000); i++)
            {
                var member = Marshal.PtrToStructure<LocalGroupMemberInfo3>(buffer + i * size);
                if (InventoryRules.Clean(Marshal.PtrToStringUni(member.DomainAndName), 200) is { } n) names.Add(n);
            }
            var (kept, cut) = InventoryRules.Bound(names.Order(StringComparer.OrdinalIgnoreCase), HardwareRules.MaxAdministrators);
            return new LocalAdministrators { Names = kept, Truncated = cut || total > read };
        }
        finally { NetApiBufferFree(buffer); }
    }

    private static AutoLogonInfo? AutoLogon()
    {
        using RegistryKey? key = Registry.LocalMachine.OpenSubKey(Winlogon);
        if (key is null) return null;
        bool on = HardwareRules.AutoLogonOn(key.GetValue("AutoAdminLogon"));
        // The user name is read only when automatic sign-in is on. The stored password value is never opened.
        return new AutoLogonInfo { Enabled = on, UserName = on ? InventoryRules.Clean(key.GetValue("DefaultUserName") as string, 120) : null };
    }

    /// <summary>When Group Policy last finished applying to the computer, from the two halves of the time Windows keeps; null when the key is absent.</summary>
    private static DateTimeOffset? GroupPolicyTime()
    {
        using RegistryKey? all = Registry.LocalMachine.OpenSubKey($@"{GroupPolicyMachine}\Extension-List\{{00000000-0000-0000-0000-000000000000}}");
        if (all is null) return null;
        return HardwareRules.FileTimeFromParts(all.GetValue("EndTimeLo"), all.GetValue("EndTimeHi"))
            ?? HardwareRules.FileTimeFromParts(all.GetValue("StartTimeLo"), all.GetValue("StartTimeHi"));
    }
}

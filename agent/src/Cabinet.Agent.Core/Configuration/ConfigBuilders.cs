using System.Globalization;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Core.Configuration;

/// <summary>
/// Turns what the read operations return into configuration items (docs/spec/15-baselines-and-config.md). Pure: no Windows
/// call here, so every rule is tested on any machine. Keys are stable names (never indexes); values are flat; nothing that changes by
/// itself (uptime, last sync time, lease times, counters, process IDs, transitional service states) is included, so a hash changes only
/// when the configuration does. Nothing secret is read or kept: a startup command is reduced to its program, and the file contents of
/// the hosts file and of the registry are never included, only the names and addresses the existing reads already return. Each category
/// is capped at <see cref="MaxItems"/> items and <see cref="MaxCategoryBytes"/> bytes and says so when it is cut.
/// </summary>
public static class ConfigBuilders
{
    public const int MaxItems = 2000;
    /// <summary>The most one category's canonical JSON may be; a larger one is cut and marked truncated (a request body is limited to 1 MB).</summary>
    public const int MaxCategoryBytes = 256 * 1024;
    /// <summary>The most one answer to config.snapshot may hold in all (the result is a request body too).</summary>
    public const int MaxSnapshotBytes = 900 * 1024;
    private const int MaxList = 32;

    public static string Snake(Enum value) => System.Text.Json.JsonNamingPolicy.SnakeCaseLower.ConvertName(value.ToString());

    /// <summary>Single-line text for a value: control characters become spaces, a lone surrogate (which would hash differently in JavaScript) becomes U+FFFD, trimmed and capped.</summary>
    public static string? Text(string? text, int max = 200)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        string clean = EventText.ShortText(text, max);
        if (clean.Length == 0) return null;
        char[]? fixedUp = null;
        for (int i = 0; i < clean.Length; i++)
        {
            char c = clean[i];
            bool pair = char.IsHighSurrogate(c) && i + 1 < clean.Length && char.IsLowSurrogate(clean[i + 1]);
            if (pair) { i++; continue; }
            if (char.IsSurrogate(c)) { fixedUp ??= clean.ToCharArray(); fixedUp[i] = '�'; }
        }
        return fixedUp is null ? clean : new string(fixedUp);
    }

    /// <summary>A key made of a prefix and a name; null when the name leaves nothing usable. Angle brackets are not allowed in a key.</summary>
    private static string? Key(string prefix, string? name)
    {
        string? clean = Text(name?.Replace('<', ' ').Replace('>', ' '), 180);
        return clean is null ? null : prefix + ":" + clean;
    }

    private static ConfigItem? Item(string? key, params (string Name, object? Value)[] values) => key is null ? null : new ConfigItem
    {
        Key = key,
        Values = values.Where(v => v.Value is not null).ToDictionary(v => v.Name, v => v.Value, StringComparer.Ordinal),
    };

    private static List<string> TextList(IEnumerable<string?> values) => values.Select(v => Text(v)).Where(v => v is not null).Select(v => v!).Take(MaxList).ToList();

    private static string Day(DateTimeOffset? at) => at is { } t ? t.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : "";

    /// <summary>Sorts, makes keys unique, caps (by count and by size), and hashes.</summary>
    public static ConfigSnapshotCategory Make(ConfigCategory category, IEnumerable<ConfigItem?> items)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var unique = new List<ConfigItem>();
        foreach (ConfigItem? item in items.Where(i => i is not null).OrderBy(i => i!.Key, StringComparer.Ordinal))
        {
            string key = item!.Key;
            for (int n = 2; !seen.Add(key); n++) key = $"{item.Key}#{n}";
            unique.Add(key == item.Key ? item : item with { Key = key });
        }
        bool truncated = unique.Count > MaxItems;
        if (truncated) unique = unique.Take(MaxItems).ToList();
        long bytes = 2;
        for (int i = 0; i < unique.Count; i++)
        {
            bytes += ConfigCanonical.ItemLength(unique[i]);
            if (bytes <= MaxCategoryBytes) continue;
            unique = unique.Take(i).ToList();
            truncated = true;
            break;
        }
        return new ConfigSnapshotCategory { Category = category, Hash = ConfigCanonical.Hash(unique), Truncated = truncated, Items = unique };
    }

    /// <summary>The first <paramref name="keep"/> items of a category, marked truncated, with its hash made again (the hash always describes the items it travels with).</summary>
    public static ConfigSnapshotCategory Cut(ConfigSnapshotCategory category, int keep)
    {
        var items = category.Items.Take(Math.Max(0, keep)).ToList();
        return category with { Items = items, Truncated = true, Hash = ConfigCanonical.Hash(items) };
    }

    public static long Size(ConfigSnapshotCategory category) => 2 + category.Items.Sum(ConfigCanonical.ItemLength);

    // ---- Network: adapters (addresses, DHCP, gateways, DNS, metric) and the routes the existing read returns ----------------------------------

    public static ConfigSnapshotCategory Network(NetworkConfigOutput output)
    {
        var names = new Dictionary<int, string>();
        foreach (NetworkAdapter a in output.Adapters) names.TryAdd(a.InterfaceIndex, a.Name);
        var items = new List<ConfigItem?>();
        foreach (NetworkAdapter a in output.Adapters)
            items.Add(Item(Key("adapter", a.Name),
                ("type", Snake(a.Type)), ("connected", a.Connected), ("dhcp", a.Ipv4.Dhcp), ("dhcpServer", Text(a.Details?.DhcpServer, 64)),
                ("addresses", a.Ipv4.Addresses.Select(x => $"{x.Address}/{x.PrefixLength}").Take(MaxList).ToList()),
                ("gateways", a.Ipv4.Gateways.Take(MaxList).ToList()),
                ("dnsServers", a.Dns.Servers.Take(MaxList).ToList()), ("dnsAutomatic", a.Dns.Automatic), ("dnsSuffix", Text(a.DnsSuffix)),
                ("linkSpeedMbps", a.LinkSpeedBps is { } bps ? (int)Math.Min(int.MaxValue, bps / 1_000_000) : null),
                ("mac", Text(a.MacAddress, 32)), ("interfaceIndex", a.InterfaceIndex),
                ("metric", a.Details?.InterfaceMetric), ("mtu", a.Details?.Mtu), ("networkProfile", Text(a.Details?.NetworkProfile?.Category, 32)),
                ("driverVersion", Text(a.Details?.Driver?.Version))));
        foreach (RouteEntry r in output.Routes ?? [])
        {
            // Loopback, multicast, broadcast and a host's own address are not routes anyone configured.
            if (r.Destination.StartsWith("127.", StringComparison.Ordinal) || r.Destination == "255.255.255.255" || IsMulticast(r.Destination)) continue;
            if (r.PrefixLength == 32 && r.NextHop == "0.0.0.0") continue;
            items.Add(Item(Key("route", $"{r.Destination}/{r.PrefixLength} via {r.NextHop}"),
                ("metric", (int)Math.Clamp(r.Metric, 0, 9999)), ("adapter", names.TryGetValue(r.InterfaceIndex, out string? n) ? Text(n) : null)));
        }
        return Make(ConfigCategory.Network, items);
    }

    private static bool IsMulticast(string address) =>
        int.TryParse(address.AsSpan(0, Math.Max(0, address.IndexOf('.'))), NumberStyles.None, CultureInfo.InvariantCulture, out int first) && first is >= 224 and <= 239;

    // ---- Services: start type and state ---------------------------------------------------------------------------------------------------

    /// <summary>A transitional state is the state the service is heading to, so a service that is starting does not look changed.</summary>
    public static string ServiceStateName(ServiceState s) => s switch
    {
        ServiceState.Running or ServiceState.StartPending or ServiceState.ContinuePending => "running",
        ServiceState.Stopped or ServiceState.StopPending => "stopped",
        ServiceState.Paused or ServiceState.PausePending => "paused",
        _ => "unknown",
    };

    public static ConfigSnapshotCategory Services(ServicesListOutput output) => Make(ConfigCategory.Services, output.Services.Select(s =>
        Item(Key("service", s.Name), ("startType", Snake(s.StartType)), ("state", ServiceStateName(s.State)), ("account", Text(s.Account)), ("path", Text(s.ExecutablePath)))));

    // ---- Drivers, updates, devices ------------------------------------------------------------------------------------------------------

    public static ConfigSnapshotCategory Drivers(DriversListOutput output) => Make(ConfigCategory.Drivers, output.Drivers.Select(d =>
        Item(Key("driver", d.PublishedName), ("originalName", Text(d.OriginalName)), ("version", Text(d.Version)), ("date", d.Date is null ? null : Day(d.Date)),
            ("provider", Text(d.Provider)), ("class", Text(d.ClassName)), ("signer", Text(d.Signer)))));

    public static ConfigSnapshotCategory Updates(UpdatesStatusOutput output) => Make(ConfigCategory.Updates, output.Installed.Select(u =>
        Item(Key("update", u.Kb ?? u.Title), ("title", Text(u.Title)),
            ("installedAt", u.InstalledAt?.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture)), ("result", Snake(u.Result)))));

    public static ConfigSnapshotCategory Devices(DevicesListOutput output) => Make(ConfigCategory.Devices, output.Devices.Select(d =>
        Item(Key("device", d.InstanceId), ("class", Text(d.Class)), ("name", Text(d.Name)), ("status", Text(d.Status, 64)),
            ("errorCode", d.ErrorCode is { } e and >= 0 and <= int.MaxValue ? (int)e : null), ("driver", Text(d.Driver?.Name)), ("driverVersion", Text(d.Driver?.Version)))));

    // ---- Firewall: profiles and rules ---------------------------------------------------------------------------------------------------

    public static ConfigSnapshotCategory Firewall(FirewallStateOutput output)
    {
        var items = new List<ConfigItem?>();
        foreach (FirewallProfileState p in output.Profiles)
            items.Add(Item("profile:" + Snake(p.Profile), ("enabled", p.Enabled), ("defaultInbound", Snake(p.DefaultInbound)), ("defaultOutbound", Snake(p.DefaultOutbound))));
        foreach (ReportedFirewallRule r in output.Rules)
            items.Add(Item(Key("rule", r.Name),
                ("enabled", r.Enabled), ("direction", Snake(r.Direction)), ("action", Snake(r.Action)), ("protocol", Text(r.Protocol, 32)),
                ("localPorts", Text(r.LocalPorts)), ("remotePorts", Text(r.RemotePorts)), ("localAddresses", Text(r.LocalAddresses)), ("remoteAddresses", Text(r.RemoteAddresses)),
                ("program", Text(r.ProgramPath)), ("profiles", r.Profiles?.Select(p => Snake(p)).ToList()), ("platform", r.CreatedByPlatform)));
        // Rules past the agent's own cap are left out, and the category says so.
        var made = Make(ConfigCategory.Firewall, items);
        return output.RulesTruncated ? made with { Truncated = true } : made;
    }

    // ---- Time -----------------------------------------------------------------------------------------------------------------------------------

    public static ConfigSnapshotCategory Time(TimeStatusOutput t) => Make(ConfigCategory.Time, [Item("time",
        ("timeZoneId", Text(t.TimeZoneId, 64)), ("syncSource", Text(t.Sync.Source)), ("timeService", Snake(t.TimeService)), ("policyManaged", t.PolicyManaged))]);

    // ---- Installed software: programs by name (the 32-bit and 64-bit lists are one) -----------------------------------------------------

    public static ConfigSnapshotCategory Applications(SoftwareListOutput output)
    {
        var best = new Dictionary<string, InstalledProgram>(StringComparer.Ordinal);
        foreach (InstalledProgram p in output.Programs)
        {
            if (Text(p.Name) is not { } name) continue;
            if (!best.TryGetValue(name, out InstalledProgram? seen) || string.CompareOrdinal(p.Version ?? "", seen.Version ?? "") > 0) best[name] = p;
        }
        var made = Make(ConfigCategory.Applications, best.Select(b => Item(Key("app", b.Key), ("version", Text(b.Value.Version)), ("publisher", Text(b.Value.Publisher)))));
        return output.Truncated ? made with { Truncated = true } : made;
    }

    // ---- The hosts file: addresses and names only; comments and every other line are never read --------------------------------------

    public static ConfigSnapshotCategory Hosts(NetworkHostsOutput output)
    {
        var byAddress = new Dictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        foreach (HostsEntry e in output.Entries)
        {
            if (Text(e.Address, 64) is not { } address) continue;
            if (!byAddress.TryGetValue(address, out SortedSet<string>? names)) byAddress[address] = names = new SortedSet<string>(StringComparer.Ordinal);
            foreach (string? name in e.Names.Select(n => Text(n, 253))) if (name is not null) names.Add(name);
        }
        var made = Make(ConfigCategory.Hosts, byAddress.Select(b => Item(Key("host", b.Key), ("names", b.Value.Take(MaxList).ToList()))));
        return output.Truncated ? made with { Truncated = true } : made;
    }

    // ---- Scheduled tasks and what starts with Windows: state of a task; the program (never the arguments) of a startup entry -----

    /// <summary>The program of a command, never its arguments: a quoted path, or up to ".exe", or the first word. No pattern matching, only searching.</summary>
    public static string ProgramOf(string command)
    {
        string c = command.Trim();
        if (c.StartsWith('"'))
        {
            int end = c.IndexOf('"', 1);
            return end > 1 ? c[1..end] : c[1..];
        }
        int exe = c.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
        if (exe > 0) return c[..(exe + 4)];
        int space = c.IndexOf(' ');
        return space > 0 ? c[..space] : c;
    }

    public static ConfigSnapshotCategory Tasks(StartupListOutput output)
    {
        var items = new List<ConfigItem?>();
        foreach (ScheduledTaskInfo t in output.Tasks) items.Add(Item(Key("task", t.Path + t.Name), ("state", Snake(t.State))));
        foreach (StartupItem s in output.Startup) items.Add(Item(Key("startup", $"{s.Location}/{s.Name}"), ("program", Text(ProgramOf(s.Command)))));
        var made = Make(ConfigCategory.Tasks, items);
        return output.Truncated ? made with { Truncated = true } : made;
    }

    // ---- Hardware and identity ------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// The make and model, BIOS, processor, memory and security chip; and how the computer is joined, its local administrators and automatic
    /// sign-in (never a password). The cabinet's own name before a backslash becomes "." so the same account has the same text on every cabinet.
    /// </summary>
    public static ConfigSnapshotCategory Machine(SystemHardwareOutput hardware, SystemIdentityOutput identity, string machineName)
    {
        string prefix = machineName + "\\";
        var admins = (identity.LocalAdministrators?.Names ?? [])
            .Select(n => Text(n.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? ".\\" + n[prefix.Length..] : n)).Where(n => n is not null).Select(n => n!)
            .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        return Make(ConfigCategory.System, [
            Item("hardware", ("manufacturer", Text(hardware.Manufacturer)), ("model", Text(hardware.Model)), ("biosVendor", Text(hardware.Bios.Vendor)), ("biosVersion", Text(hardware.Bios.Version)),
                ("biosDate", hardware.Bios.Date is null ? null : Day(hardware.Bios.Date)), ("cpu", Text(hardware.Cpu.Model)),
                ("logicalCores", hardware.Cpu.LogicalCores is { } cores and >= 0 and <= int.MaxValue ? (int)cores : null),
                ("memoryMb", hardware.Memory.TotalBytes is { } bytes and >= 0 ? (int)Math.Min(int.MaxValue, bytes / (1024 * 1024)) : null),
                ("memoryModules", hardware.Memory.ModuleCount is { } modules and >= 0 and <= int.MaxValue ? (int)modules : null),
                ("tpmPresent", hardware.Tpm?.Present), ("tpmEnabled", hardware.Tpm?.Enabled), ("tpmVersion", Text(hardware.Tpm?.Version, 32)),
                ("secureBoot", hardware.SecureBoot is { } sb ? Snake(sb) : null)),
            Item("identity", ("joinType", Snake(identity.JoinType)), ("name", Text(identity.Name)), ("domainControllerFound", identity.DomainControllerFound),
                ("autoLogon", identity.AutoLogon?.Enabled), ("autoLogonUser", Text(identity.AutoLogon?.UserName)),
                ("localAdministrators", admins.Take(MaxList).ToList()), ("localAdministratorsTruncated", admins.Count > MaxList || identity.LocalAdministrators?.Truncated == true)),
        ]);
    }
}

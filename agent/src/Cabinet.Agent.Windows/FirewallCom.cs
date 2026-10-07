using System.Collections;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;
using Cabinet.Agent.Core.Writes;

namespace Cabinet.Agent.Windows;

/// <summary>
/// The Windows Firewall through its own programming interface (HNetCfg.FwPolicy2): read by the
/// network process for firewall.state, changed by the broker one rule or profile at a time.
/// Whole-configuration snapshots use netsh export and import, by full path with argument arrays.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class FirewallCom : IFirewallControl
{
    public const string RuleGroup = "Mashura cabinet diagnostics";
    private static readonly (int Bit, FirewallProfile Profile)[] Bits = [(1, FirewallProfile.Domain), (2, FirewallProfile.Private), (4, FirewallProfile.Public)];

    private static T WithPolicy<T>(Func<dynamic, T> body)
    {
        object? policy = null;
        try
        {
            Type type = Type.GetTypeFromProgID("HNetCfg.FwPolicy2", throwOnError: false)
                ?? throw new OperationFailedException("unavailable", "Windows Firewall is not available on this cabinet.");
            policy = Activator.CreateInstance(type)!;
            return body(policy);
        }
        catch (COMException) { throw new OperationFailedException("unavailable", "Windows Firewall did not answer."); }
        catch (UnauthorizedAccessException) { throw new OperationFailedException("execution_failed", "Windows refused the firewall change."); }
        finally { if (policy is not null && Marshal.IsComObject(policy)) Marshal.FinalReleaseComObject(policy); }
    }

    private static int Bit(FirewallProfile p) => Bits.First(b => b.Profile == p).Bit;

    public FirewallStateOutput Read() => Read(CancellationToken.None);

    public static FirewallStateOutput Read(CancellationToken token) => WithPolicy(fw =>
    {
        var profiles = Bits.Select(b => new FirewallProfileState
        {
            Profile = b.Profile, Enabled = (bool)fw.FirewallEnabled[b.Bit],
            DefaultInbound = (int)fw.DefaultInboundAction[b.Bit] == 1 ? FirewallAction.Allow : FirewallAction.Block,
            DefaultOutbound = (int)fw.DefaultOutboundAction[b.Bit] == 1 ? FirewallAction.Allow : FirewallAction.Block,
            ReenableAt = null,
        }).ToList();
        var rules = new List<ReportedFirewallRule>();
        bool truncated = false;
        foreach (dynamic rule in (IEnumerable)fw.Rules)
        {
            token.ThrowIfCancellationRequested();
            if (rules.Count == 10_000) { truncated = true; break; }
            ReportedFirewallRule? r = Report(rule);
            if (r is not null) rules.Add(r);
        }
        return new FirewallStateOutput { Profiles = profiles, Rules = rules, RulesTruncated = truncated, Snapshots = [] };
    });

    private static ReportedFirewallRule? Report(dynamic rule)
    {
        string name = EventText.ShortText((string?)rule.Name);
        if (name.Length == 0) return null;
        int protocol = (int)rule.Protocol;
        int mask = (int)rule.Profiles;
        return new ReportedFirewallRule
        {
            Name = name,
            DisplayGroup = Field((string?)rule.Grouping),
            Direction = (int)rule.Direction == 2 ? FirewallDirection.Out : FirewallDirection.In,
            Action = (int)rule.Action == 1 ? FirewallAction.Allow : FirewallAction.Block,
            Protocol = protocol switch { 6 => "TCP", 17 => "UDP", 1 => "ICMPv4", 58 => "ICMPv6", 256 => "Any", _ => protocol.ToString(CultureInfo.InvariantCulture) },
            LocalPorts = protocol is 6 or 17 ? Field((string?)rule.LocalPorts) : null,
            RemotePorts = protocol is 6 or 17 ? Field((string?)rule.RemotePorts) : null,
            LocalAddresses = Field((string?)rule.LocalAddresses),
            RemoteAddresses = Field((string?)rule.RemoteAddresses),
            ProgramPath = Field((string?)rule.ApplicationName),
            Profiles = mask == 0x7FFFFFFF ? Bits.Select(b => b.Profile).ToList() : Bits.Where(b => (mask & b.Bit) != 0).Select(b => b.Profile).ToList(),
            Enabled = (bool)rule.Enabled,
            CreatedByPlatform = name.StartsWith(BrokerWrites.PlatformRulePrefix, StringComparison.Ordinal),
        };
    }

    /// <summary>A firewall text field: long lists are cut with a marker rather than failing the whole listing.</summary>
    private static string? Field(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        string clean = EventText.ShortText(text, 10_000);
        return clean.Length <= 256 ? clean : EventText.Cap(clean, 253) + "...";
    }

    public void SetProfile(FirewallProfile profile, bool enabled, FirewallAction inbound, FirewallAction outbound) => WithPolicy<int>(fw =>
    {
        int bit = Bit(profile);
        fw.DefaultInboundAction[bit] = inbound == FirewallAction.Allow ? 1 : 0;
        fw.DefaultOutboundAction[bit] = outbound == FirewallAction.Allow ? 1 : 0;
        fw.FirewallEnabled[bit] = enabled;
        return 0;
    });

    /// <summary>The rules with this exact name. Typed as object so LINQ binds statically, not through dynamic dispatch.</summary>
    private static List<object> Named(object policy, string name)
    {
        dynamic fw = policy;
        var found = new List<object>();
        foreach (dynamic rule in (IEnumerable)fw.Rules)
            if (string.Equals((string?)rule.Name, name, StringComparison.Ordinal)) found.Add((object)rule);
        return found;
    }

    public int CountRules(string name) => WithPolicy(fw => Named((object)fw, name).Count);

    public ReportedFirewallRule? ReadRule(string name) => WithPolicy(fw =>
    {
        object? rule = Named((object)fw, name).FirstOrDefault();
        return rule is null ? null : (ReportedFirewallRule?)Report((dynamic)rule);
    });

    public void CreateRule(FirewallRule rule) => WithPolicy<int>(fw =>
    {
        Type type = Type.GetTypeFromProgID("HNetCfg.FWRule", throwOnError: true)!;
        dynamic r = Activator.CreateInstance(type)!;
        try
        {
            r.Name = rule.Name;
            r.Grouping = RuleGroup;
            r.Description = "Created through the Mashura cabinet diagnostics platform.";
            Apply(r, rule);
            fw.Rules.Add(r);
        }
        finally { if (Marshal.IsComObject(r)) Marshal.FinalReleaseComObject(r); }
        return 0;
    });

    public void UpdateRule(string name, FirewallRule rule) => WithPolicy<int>(fw =>
    {
        dynamic r = Named((object)fw, name).Single();
        Apply(r, rule);
        if (rule.Name != name) r.Name = rule.Name;
        return 0;
    });

    public void SetRuleEnabled(string name, bool enabled) => WithPolicy<int>(fw => { dynamic r = Named((object)fw, name).Single(); r.Enabled = enabled; return 0; });

    public void DeleteRule(string name) => WithPolicy<int>(fw => { fw.Rules.Remove(name); return 0; });

    /// <summary>Every structured field, in the order Windows needs (protocol before ports).</summary>
    private static void Apply(dynamic r, FirewallRule rule)
    {
        r.Direction = rule.Direction == FirewallDirection.Out ? 2 : 1;
        r.Action = rule.Action == FirewallAction.Allow ? 1 : 0;
        r.Protocol = rule.Protocol switch { FirewallProtocol.Tcp => 6, FirewallProtocol.Udp => 17, FirewallProtocol.Icmpv4 => 1, _ => 256 };
        if (rule.Protocol is FirewallProtocol.Tcp or FirewallProtocol.Udp)
        {
            r.LocalPorts = Ports(rule.LocalPorts);
            r.RemotePorts = Ports(rule.RemotePorts);
        }
        r.LocalAddresses = rule.LocalAddresses is { Count: > 0 } la ? string.Join(',', la) : "*";
        r.RemoteAddresses = rule.RemoteAddresses is { Count: > 0 } ra ? string.Join(',', ra) : "*";
        r.ApplicationName = rule.ProgramPath ?? null;
        r.Profiles = rule.Profiles.Count == 0 ? 0x7FFFFFFF : rule.Profiles.Sum(Bit);
        r.Enabled = rule.Enabled;
    }

    private static string Ports(IReadOnlyList<PortRange>? ranges) =>
        ranges is { Count: > 0 } ? string.Join(',', ranges.Select(p => p.From == p.To ? p.From.ToString(CultureInfo.InvariantCulture) : $"{p.From}-{p.To}")) : "*";

    public void Export(string path) => Netsh("export", path);
    public void Import(string path) => Netsh("import", path);

    private static void Netsh(string verb, string path)
    {
        var outcome = ExternalProgram.Run("netsh.exe", ["advfirewall", verb, path], TimeSpan.FromSeconds(60));
        if (outcome.ExitCode != 0) throw new OperationFailedException("execution_failed", $"netsh advfirewall {verb} failed (exit code {outcome.ExitCode}).");
    }
}

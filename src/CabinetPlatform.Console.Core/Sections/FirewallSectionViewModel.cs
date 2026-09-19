using System.Collections.ObjectModel;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>Historical firewall observations. No write controls or automatic repair exist here.</summary>
public sealed class FirewallSectionViewModel() : MachineSectionViewModel(
    "Windows firewall", "Read-only firewall profiles and bounded rule metadata; not a connectivity diagnosis")
{
    public ObservableCollection<FirewallProfileRow> Profiles { get; } = new();
    public ObservableCollection<FirewallRuleRow> Rules { get; } = new();
    public string ResultSummary { get; private set; } = "Unknown: no firewall inspection collected.";
    public string PolicyCaveat => new FirewallInspection().PolicyCaveat;
    public string RepairStatus => "Automatic repair OFF. Manual rule changes and process stopping remain blocked in this release; new site-scoped approval, recovery and native validation are required.";

    public override void Apply(CabinetDetailDto? latest, DateTimeOffset nowUtc)
    {
        Profiles.Clear();
        Rules.Clear();
        ResultSummary = "Unknown: no firewall inspection collected. Use Inspect Windows firewall, then refresh action results.";
        Availability = SectionAvailability.OnDemandOnly("Windows firewall", "Inspect Windows firewall");
        OnPropertyChanged(nameof(ResultSummary));
    }

    public bool TryApply(FirewallInspection result)
    {
        if (result.Version != 1 || result.ObservedUtc == default || !Enum.IsDefined(result.Status) ||
            result.Profiles is null || result.Rules is null || result.Profiles.Count > 3 || result.Rules.Count > 128 ||
            result.Profiles.Any(p => p is null || p.Profile is not (1 or 2 or 4) || !Enum.IsDefined(p.Status)) ||
            result.Profiles.Select(p => p.Profile).Distinct().Count() != result.Profiles.Count ||
            result.Rules.Any(r => r is null || new[] { r.Name, r.LocalPorts, r.RemotePorts, r.LocalAddresses, r.RemoteAddresses }
                .Any(s => s is null || s.Length > 256 || s.Any(c => char.IsControl(c) || char.GetUnicodeCategory(c) == System.Globalization.UnicodeCategory.Format)))) return false;
        Profiles.Clear();
        foreach (var profile in result.Profiles) Profiles.Add(new(profile));
        Rules.Clear();
        foreach (var rule in result.Rules) Rules.Add(new(rule));
        ResultSummary = $"{result.Status}. Historical observation {result.ObservedUtc:O} (UTC); current state unverified. " +
            $"Active profile mask: {result.ActiveProfiles?.ToString() ?? "unknown"}. " +
            $"Local policy modify state: {ModifyState(result.LocalPolicyModifyState)}. " +
            $"{Rules.Count} rule rows; {(result.RulesTruncated ? "truncated or incomplete" : "enumeration completed")}; " +
            $"{(result.TextTruncated ? "some text truncated" : "text not truncated")}. " +
            "Two-second cooperative read budget; synchronous Windows calls may take longer.";
        Availability = SectionAvailability.Available;
        OnPropertyChanged(nameof(ResultSummary));
        return true;
    }

    private static string ModifyState(int? value) => value switch
    {
        0 => "OK (not authorization to change)", 1 => "GPO override", 2 => "inbound blocked", _ => "unknown"
    };
    public override string Summarise() => ResultSummary;
}

public sealed record FirewallProfileRow(FirewallProfileObservation Observation)
{
    public string Name => Observation.Profile switch { 1 => "Domain", 2 => "Private", 4 => "Public", _ => "Unknown" };
    public string Status => Observation.Status.ToString();
    public string Enabled => Read ? Observation.Enabled?.ToString() ?? "Unknown" : "Unknown";
    public string BlockAllInbound => Read ? Observation.BlockAllInbound?.ToString() ?? "Unknown" : "Unknown";
    public string DefaultInbound => FirewallRuleRow.ActionName(Read ? Observation.DefaultInboundAction : null);
    public string DefaultOutbound => FirewallRuleRow.ActionName(Read ? Observation.DefaultOutboundAction : null);
    private bool Read => Observation.Status == FirewallReadStatus.Read;
    public string AccessibleSummary => $"{Name}: {Status}, enabled {Enabled}, block all inbound {BlockAllInbound}, inbound {DefaultInbound}, outbound {DefaultOutbound}";
}

public sealed record FirewallRuleRow(FirewallRuleObservation Observation)
{
    public string Name => Observation.Name;
    public string Enabled => Observation.Enabled ? "Enabled (configured)" : "Disabled (configured)";
    public string Direction => Observation.Direction switch { 1 => "Inbound", 2 => "Outbound", _ => "Unknown" };
    public string Action => ActionName(Observation.Action);
    public string Protocol => Observation.Protocol switch { 6 => "TCP", 17 => "UDP", 1 => "ICMPv4", 58 => "ICMPv6", 256 => "Any", _ => Observation.Protocol.ToString() };
    public string AccessibleSummary => $"{Name}: {Enabled}, {Direction}, {Action}, {Protocol}; configured only, effective permission unverified";
    public static string ActionName(int? action) => action switch { 0 => "Block", 1 => "Allow", _ => "Unknown" };
}

using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Read-only native boundary. Intentionally exposes no setters or rule mutation.</summary>
public interface IFirewallGateway
{
    IFirewallSession Open();
}

/// <summary>One owned native snapshot session; enumeration remains cooperative.</summary>
public interface IFirewallSession : IDisposable
{
    int ActiveProfiles { get; }
    int LocalPolicyModifyState { get; }
    FirewallProfileObservation ReadProfile(int profile);
    IEnumerable<FirewallRuleObservation> ReadRules();
}

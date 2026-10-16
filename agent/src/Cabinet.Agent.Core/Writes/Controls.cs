using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Writes;

/// <summary>
/// The Windows Firewall, as the broker changes it. The Windows implementation uses the firewall's
/// own programming interface for single changes, and netsh export/import for whole snapshots.
/// Tests use an in-memory one.
/// </summary>
public interface IFirewallControl
{
    /// <summary>Profiles and every rule, exactly as firewall.state reports them (no snapshots or timers).</summary>
    FirewallStateOutput Read();
    void SetProfile(FirewallProfile profile, bool enabled, FirewallAction inbound, FirewallAction outbound);
    /// <summary>How many rules carry this exact name (Windows allows duplicates).</summary>
    int CountRules(string name);
    ReportedFirewallRule? ReadRule(string name);
    void CreateRule(FirewallRule rule);
    void UpdateRule(string name, FirewallRule rule);
    void SetRuleEnabled(string name, bool enabled);
    void DeleteRule(string name);
    /// <summary>Saves the complete configuration to a file the broker owns.</summary>
    void Export(string path);
    /// <summary>Replaces the complete configuration with a saved one.</summary>
    void Import(string path);
}

/// <summary>One network adapter's IPv4 and DNS settings, as the broker changes them.</summary>
public interface INetworkControl
{
    /// <exception cref="OperationFailedException">not_found when no adapter has this index.</exception>
    (Ipv4Settings Ip, DnsSettings Dns) Read(int interfaceIndex);
    void SetDhcp(int interfaceIndex);
    /// <summary>A static address; <paramref name="gateway"/> is null for a link that has no router, and then no gateway is left set.</summary>
    void SetStatic(int interfaceIndex, string address, int prefixLength, string? gateway);
    void SetDns(int interfaceIndex, DnsSettings dns);
    /// <summary>Asks the DHCP server for a new lease (the adapter's RenewDHCPLease); returns Windows' result code, 0 for success.</summary>
    int RenewLease(int interfaceIndex);
    /// <summary>Gives the current lease back (the adapter's ReleaseDHCPLease); returns Windows' result code, 0 for success.</summary>
    int ReleaseLease(int interfaceIndex);
    /// <summary>Empties the DNS resolver cache; true when Windows reported success.</summary>
    bool FlushDns();
    /// <summary>Puts back settings read earlier (the safety net's rollback).</summary>
    void Restore(int interfaceIndex, Ipv4Settings ip);
}

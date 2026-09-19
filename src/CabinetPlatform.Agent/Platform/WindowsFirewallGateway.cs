using System.Collections;
using System.Runtime.InteropServices;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Windows Defender Firewall COM reads only. No PowerShell, netsh, or rule setters.</summary>
public sealed class WindowsFirewallGateway : IFirewallGateway
{
    private readonly Func<object> _createPolicy;
    public WindowsFirewallGateway() : this(CreatePolicy) { }
    public WindowsFirewallGateway(Func<object> createPolicy) => _createPolicy = createPolicy;
    public IFirewallSession Open() => new Session(_createPolicy());

    private static object CreatePolicy()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var type = Type.GetTypeFromProgID("HNetCfg.FwPolicy2", throwOnError: true)!;
        return Activator.CreateInstance(type) ?? throw new InvalidOperationException("Firewall policy unavailable.");
    }

    private sealed class Session(object policy) : IFirewallSession
    {
        private readonly dynamic _policy = policy;
        public int ActiveProfiles => (int)_policy.CurrentProfileTypes;
        public int LocalPolicyModifyState => (int)_policy.LocalPolicyModifyState;

        public FirewallProfileObservation ReadProfile(int profile) => new()
        {
            Profile = profile, Status = FirewallReadStatus.Read,
            Enabled = (bool)_policy.FirewallEnabled[profile],
            BlockAllInbound = (bool)_policy.BlockAllInboundTraffic[profile],
            DefaultInboundAction = (int)_policy.DefaultInboundAction[profile],
            DefaultOutboundAction = (int)_policy.DefaultOutboundAction[profile]
        };

        public IEnumerable<FirewallRuleObservation> ReadRules()
        {
            object collection = _policy.Rules;
            IEnumerator? iterator = null;
            try
            {
                iterator = ((IEnumerable)collection).GetEnumerator();
                while (iterator.MoveNext())
                {
                    object native = iterator.Current;
                    FirewallRuleObservation row;
                    try
                    {
                        dynamic rule = native;
                        int protocol = (int)rule.Protocol;
                        row = new()
                        {
                            Name = (string)rule.Name, Enabled = (bool)rule.Enabled,
                            Profiles = (int)rule.Profiles, Direction = (int)rule.Direction,
                            Action = (int)rule.Action, Protocol = protocol,
                            LocalPorts = protocol is 6 or 17 ? (string)rule.LocalPorts : string.Empty,
                            RemotePorts = protocol is 6 or 17 ? (string)rule.RemotePorts : string.Empty,
                            LocalAddresses = (string)rule.LocalAddresses, RemoteAddresses = (string)rule.RemoteAddresses
                        };
                    }
                    finally { Release(native); }
                    yield return row;
                }
            }
            finally
            {
                (iterator as IDisposable)?.Dispose();
                if (iterator is not null) Release(iterator);
                Release(collection);
            }
        }

        public void Dispose() => Release((object)_policy);
    }

    private static void Release(object value)
    {
        if (OperatingSystem.IsWindows() && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
    }
}

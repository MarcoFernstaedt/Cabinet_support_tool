using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Connectivity;

/// <summary>Read-only source profile clue for an approved sync target. Not a packet verdict.</summary>
public sealed class WindowsSourceFirewallCheck(FirewallReader reader) : ISourceFirewallCheck
{
    // Singleton across sampler renewals. A hung native COM call must not spawn another one.
    private int _active;

    public SourceFirewallCheck Read(DateTimeOffset observedUtc, CancellationToken ct)
    {
        if (Interlocked.CompareExchange(ref _active, 1, 0) != 0)
            return new() { ObservedUtc = observedUtc, Status = FirewallReadStatus.Unavailable };
        try
        {
            var inspection = reader.ReadProfiles(ct);
            var active = inspection.ActiveProfiles;
            bool? clue = null;
            if (active is > 0 and <= 7)
            {
                var profiles = inspection.Profiles.Where(p => (p.Profile & active.Value) != 0).ToArray();
                if (profiles.Any(p => p.Status == FirewallReadStatus.Read && p.Enabled == true && p.DefaultOutboundAction == 0))
                    clue = true;
                else if (profiles.Length == System.Numerics.BitOperations.PopCount((uint)active.Value) &&
                         profiles.All(p => p.Status == FirewallReadStatus.Read &&
                             (p.Enabled == false || p.Enabled == true && p.DefaultOutboundAction == 1)))
                    clue = false;
            }
            return new SourceFirewallCheck
            {
                ObservedUtc = inspection.ObservedUtc,
                Status = inspection.Status,
                HasOutboundProfileBlockClue = clue
            };
        }
        finally { Volatile.Write(ref _active, 0); }
    }
}

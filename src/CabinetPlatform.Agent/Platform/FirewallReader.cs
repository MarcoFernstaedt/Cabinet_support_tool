using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Fixed, small read budget. Native COM calls cannot be preempted by cancellation.</summary>
public sealed class FirewallReader(IFirewallGateway gateway, TimeProvider? timeProvider = null)
{
    public const int MaximumRules = 128;
    public const int MaximumTextLength = 256;
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;

    public FirewallInspection Read(CancellationToken cancellationToken) => ReadCore(cancellationToken, includeRules: true);

    /// <summary>Profile-only path for automatic source checks; never enumerates firewall rules.</summary>
    public FirewallInspection ReadProfiles(CancellationToken cancellationToken) => ReadCore(cancellationToken, includeRules: false);

    private FirewallInspection ReadCore(CancellationToken cancellationToken, bool includeRules)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var observed = _time.GetUtcNow();
        var started = _time.GetTimestamp();
        var profiles = new List<FirewallProfileObservation>();
        var rules = new List<FirewallRuleObservation>();
        int? active = null, modify = null;
        bool truncated = false, textTruncated = false;
        var status = FirewallReadStatus.Read;
        bool Expired() => _time.GetElapsedTime(started) >= TimeSpan.FromSeconds(2);
        try
        {
            using var session = gateway.Open();
            active = session.ActiveProfiles;
            if (includeRules) modify = session.LocalPolicyModifyState;
            foreach (int profile in new[] { 1, 2, 4 })
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (Expired()) { status = FirewallReadStatus.Partial; break; }
                try { profiles.Add(session.ReadProfile(profile)); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    profiles.Add(new() { Profile = profile, Status = Failure(ex) });
                    status = FirewallReadStatus.Partial;
                }
            }
            if (includeRules)
            {
                using var iterator = session.ReadRules().GetEnumerator();
                while (rules.Count < MaximumRules && !Expired())
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!iterator.MoveNext()) break;
                    var row = iterator.Current;
                    rules.Add(row with
                    {
                        Name = Bound(row.Name), LocalPorts = Bound(row.LocalPorts), RemotePorts = Bound(row.RemotePorts),
                        LocalAddresses = Bound(row.LocalAddresses), RemoteAddresses = Bound(row.RemoteAddresses)
                    });
                }
                // Do not consume another native row merely to prove truncation.
                truncated = rules.Count == MaximumRules || Expired();
            }
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            status = profiles.Count > 0 || rules.Count > 0 ? FirewallReadStatus.Partial : Failure(ex);
            truncated = true;
        }
        cancellationToken.ThrowIfCancellationRequested();
        return new()
        {
            ObservedUtc = observed, Status = status, ActiveProfiles = active, LocalPolicyModifyState = modify,
            Profiles = profiles, Rules = rules, RulesTruncated = truncated, TextTruncated = textTruncated,
            Note = includeRules
                ? "Historical read only. Up to 128 rules; text up to 256 characters. Two-second cooperative budget; synchronous Windows calls may take longer. Rule order is native, not priority."
                : "Historical read only source profile check. No rule enumeration. Two-second cooperative budget; synchronous Windows calls may take longer."
        };

        string Bound(string? value)
        {
            value ??= string.Empty;
            string bounded = new(value.Take(MaximumTextLength).Where(c => !char.IsControl(c) && char.GetUnicodeCategory(c) != System.Globalization.UnicodeCategory.Format).ToArray());
            textTruncated |= bounded != value;
            return bounded;
        }
    }

    private static FirewallReadStatus Failure(Exception ex) => ex switch
    {
        PlatformNotSupportedException => FirewallReadStatus.Unsupported,
        UnauthorizedAccessException => FirewallReadStatus.AccessDenied,
        System.Runtime.InteropServices.COMException com when com.HResult == unchecked((int)0x80070005) => FirewallReadStatus.AccessDenied,
        _ => FirewallReadStatus.Unavailable
    };
}

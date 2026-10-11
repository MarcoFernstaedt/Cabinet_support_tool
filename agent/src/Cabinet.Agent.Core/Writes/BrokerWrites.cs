using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Writes;

/// <summary>
/// The network and firewall writes, as the broker runs them (docs/spec/04-agent-spec.md):
/// read the "before", snapshot the firewall, make the one change, read the "after", arm
/// the safety net, and record the firewall's new fingerprint so the change detector can
/// attribute it to this command. The Windows specifics sit behind the two control interfaces.
/// </summary>
public sealed class BrokerWrites(IFirewallControl firewall, INetworkControl network, SafetyNet safetyNet, FirewallStore store, TimeProvider clock, Action<string> log)
{
    public const string PlatformRulePrefix = "MashuraDiag";
    private readonly object _gate = new(); // one change at a time

    private static Guid Command() => OperationContext.CommandId
        ?? throw new OperationFailedException("execution_failed", "A write ran without its command.");

    public OperationRegistry Register(OperationRegistry registry) => registry
        .Register<NetworkSetIpParams, NetworkSetIpOutput>(Catalog.NetworkSetIp, (p, _) => Task.FromResult(SetIp(p)))
        .Register<NetworkSetDnsParams, NetworkSetDnsOutput>(Catalog.NetworkSetDns, (p, _) => Task.FromResult(SetDns(p)))
        .Register<NetworkRenewLeaseParams, NetworkRenewLeaseOutput>(Catalog.NetworkRenewLease, (p, _) => Task.FromResult(RenewLease(p)))
        .Register<FirewallSetProfileParams, FirewallSetProfileOutput>(Catalog.FirewallSetProfile, (p, _) => Task.FromResult(SetProfile(p)))
        .Register<FirewallApplyPolicyParams, FirewallApplyPolicyOutput>(Catalog.FirewallApplyPolicy, (p, _) => Task.FromResult(ApplyPolicy(p)))
        .Register<FirewallSetRuleParams, FirewallSetRuleOutput>(Catalog.FirewallSetRule, (p, _) => Task.FromResult(SetRule(p)))
        .Register<FirewallRestoreParams, FirewallRestoreOutput>(Catalog.FirewallRestore, (p, _) => Task.FromResult(Restore(p)));

    // ---- Network ------------------------------------------------------------------------

    public NetworkSetIpOutput SetIp(NetworkSetIpParams p)
    {
        Guid command = Command();
        lock (_gate)
        {
            var (ip, dns) = network.Read(p.InterfaceIndex);
            var entry = new SafetyNet.Entry { CommandId = command, What = SafetyNet.Kind.Network, InterfaceIndex = p.InterfaceIndex, IpBefore = ip, DnsBefore = dns };
            if (p.Mode == IpMode.Static)
            {
                uint address = Ipv4(p.Address!), gateway = Ipv4(p.Gateway!);
                uint mask = p.PrefixLength == 32 ? uint.MaxValue : ~(uint.MaxValue >> p.PrefixLength!.Value);
                if ((address & mask) != (gateway & mask) || address == gateway)
                    throw new OperationFailedException("execution_failed", "The gateway must be another address on the same subnet.");
                ArmIfPartlyApplied(entry, () => network.SetStatic(p.InterfaceIndex, p.Address!, p.PrefixLength!.Value, p.Gateway!));
            }
            else ArmIfPartlyApplied(entry, () => network.SetDhcp(p.InterfaceIndex));
            DateTimeOffset deadline = safetyNet.Arm(entry);
            return new NetworkSetIpOutput { InterfaceIndex = p.InterfaceIndex, Before = ip, After = network.Read(p.InterfaceIndex).Ip, SafetyNetDeadline = deadline };
        }
    }

    /// <summary>
    /// Asks the DHCP server for a new lease. It changes no setting, so there is nothing for the safety net to undo; an adapter
    /// with a fixed address is left alone. "Renewed" needs a real address afterwards (not the 169.254 one Windows gives itself).
    /// </summary>
    public NetworkRenewLeaseOutput RenewLease(NetworkRenewLeaseParams p)
    {
        Command();
        lock (_gate)
        {
            string? before = FirstAddress(network.Read(p.InterfaceIndex).Ip);
            if (!network.Read(p.InterfaceIndex).Ip.Dhcp)
                return new() { InterfaceIndex = p.InterfaceIndex, Result = RenewLeaseResult.NotDhcp, Message = "This adapter has a fixed address, so there is no lease to renew.", AddressBefore = before, AddressAfter = before };
            int code = network.RenewLease(p.InterfaceIndex);
            string? after = FirstAddress(network.Read(p.InterfaceIndex).Ip);
            bool leased = code == 0 && after is not null && !after.StartsWith("169.254.", StringComparison.Ordinal);
            return new()
            {
                InterfaceIndex = p.InterfaceIndex, Result = leased ? RenewLeaseResult.Renewed : RenewLeaseResult.Failed, AddressBefore = before, AddressAfter = after,
                Message = leased ? "The DHCP server gave a lease." : code == 0 ? "No DHCP server answered, so there is no lease." : $"Windows could not renew the lease (code {code}).",
            };
        }
    }

    private static string? FirstAddress(Ipv4Settings ip) => ip.Addresses.Count > 0 ? ip.Addresses[0].Address : null;

    public NetworkSetDnsOutput SetDns(NetworkSetDnsParams p)
    {
        Guid command = Command();
        lock (_gate)
        {
            var (ip, dns) = network.Read(p.InterfaceIndex);
            network.SetDns(p.InterfaceIndex, p.Mode == DnsMode.Automatic
                ? new DnsSettings { Automatic = true, Servers = [] }
                : new DnsSettings { Automatic = false, Servers = p.Servers! });
            DateTimeOffset deadline = safetyNet.Arm(new SafetyNet.Entry { CommandId = command, What = SafetyNet.Kind.Network, InterfaceIndex = p.InterfaceIndex, IpBefore = ip, DnsBefore = dns });
            return new NetworkSetDnsOutput { InterfaceIndex = p.InterfaceIndex, Before = dns, After = network.Read(p.InterfaceIndex).Dns, SafetyNetDeadline = deadline };
        }
    }

    /// <summary>
    /// Makes a change that Windows may apply only in part (an address set but its gateway refused, a rule half
    /// written). If it throws, the safety net is armed with the state from before, and the failed command is never
    /// confirmed, so the cabinet goes back to that state at the deadline instead of staying half-changed.
    /// </summary>
    private void ArmIfPartlyApplied(SafetyNet.Entry before, Action change)
    {
        try { change(); }
        catch
        {
            try { safetyNet.Arm(before); }
            catch (Exception e) { log($"Arming the safety net after a failed change: {e.GetType().Name}."); }
            throw;
        }
    }

    // ---- Firewall -----------------------------------------------------------------------

    public FirewallSetProfileOutput SetProfile(FirewallSetProfileParams p)
    {
        Guid command = Command();
        lock (_gate)
        {
            DateTimeOffset now = clock.GetUtcNow();
            FirewallProfileState before = WithTimer(firewall.Read().Profiles.Single(s => s.Profile == p.Profile));
            Guid snapshot = store.TakeSnapshot(firewall, command, now);
            ArmIfPartlyApplied(new SafetyNet.Entry { CommandId = command, What = SafetyNet.Kind.Firewall, SnapshotId = snapshot },
                () => firewall.SetProfile(p.Profile, p.Enabled, p.DefaultInbound, p.DefaultOutbound));
            // Turning a profile off needs a time limit (or the explicit "no limit" only an Admin can send); the timer is kept on disk.
            if (!p.Enabled && p.DurationMinutes is { } minutes) store.SetTimer(p.Profile, now.AddMinutes(minutes), command);
            else store.ClearTimer(p.Profile);
            FirewallStateOutput after = firewall.Read();
            store.Record(command, after, now);
            DateTimeOffset deadline = safetyNet.Arm(new SafetyNet.Entry { CommandId = command, What = SafetyNet.Kind.Firewall, SnapshotId = snapshot });
            return new FirewallSetProfileOutput
            {
                Profile = p.Profile, Before = before, After = WithTimer(after.Profiles.Single(s => s.Profile == p.Profile)), SnapshotId = snapshot, SafetyNetDeadline = deadline,
            };
        }
    }

    /// <summary>
    /// firewall.applyPolicy: each profile on or off as the client's policy says, keeping its default actions. One snapshot
    /// and one safety-net window cover the whole change. The policy is the intended state, so no timer is left running on
    /// any profile; a profile already as the policy says is left alone.
    /// </summary>
    public FirewallApplyPolicyOutput ApplyPolicy(FirewallApplyPolicyParams p)
    {
        Guid command = Command();
        lock (_gate)
        {
            DateTimeOffset now = clock.GetUtcNow();
            IReadOnlyList<FirewallProfileState> before = firewall.Read().Profiles.Select(WithTimer).OrderBy(s => s.Profile).ToList();
            Guid snapshot = store.TakeSnapshot(firewall, command, now);
            var changed = new List<FirewallProfile>();
            ArmIfPartlyApplied(new SafetyNet.Entry { CommandId = command, What = SafetyNet.Kind.Firewall, SnapshotId = snapshot }, () =>
            {
                foreach (FirewallProfileState s in before)
                {
                    bool wanted = p.Profiles.For(s.Profile);
                    if (s.Enabled != wanted)
                    {
                        firewall.SetProfile(s.Profile, wanted, s.DefaultInbound, s.DefaultOutbound);
                        changed.Add(s.Profile);
                    }
                    store.ClearTimer(s.Profile);
                }
            });
            FirewallStateOutput after = firewall.Read();
            store.Record(command, after, now);
            DateTimeOffset deadline = safetyNet.Arm(new SafetyNet.Entry { CommandId = command, What = SafetyNet.Kind.Firewall, SnapshotId = snapshot });
            return new FirewallApplyPolicyOutput
            {
                Before = before, After = after.Profiles.Select(WithTimer).OrderBy(s => s.Profile).ToList(), Changed = changed, SnapshotId = snapshot, SafetyNetDeadline = deadline,
            };
        }
    }

    public FirewallSetRuleOutput SetRule(FirewallSetRuleParams p)
    {
        Guid command = Command();
        lock (_gate)
        {
            DateTimeOffset now = clock.GetUtcNow();
            string name = p.Change == RuleChange.Create ? p.Rule!.Name : p.RuleName!;
            int count = firewall.CountRules(name);
            if (p.Change == RuleChange.Create)
            {
                if (!name.StartsWith(PlatformRulePrefix, StringComparison.Ordinal))
                    throw new OperationFailedException("execution_failed", $"Rules the platform creates must be named {PlatformRulePrefix}…");
                if (count > 0) throw new OperationFailedException("execution_failed", "A rule with that name already exists.");
            }
            else if (count == 0) throw new OperationFailedException("not_found", "No firewall rule has that name.");
            else if (count > 1) throw new OperationFailedException("execution_failed", "Several firewall rules share that name, so the change would be ambiguous.");
            // An update keeps the rule's name: a rename could give a Windows rule the platform's prefix (and so its
            // attribution in the firewall history), or take it away from one of the platform's own.
            if (p.Change == RuleChange.Update && p.Rule!.Name != name)
                throw new OperationFailedException("execution_failed", "An update cannot rename a rule.");

            ReportedFirewallRule? before = p.Change == RuleChange.Create ? null : firewall.ReadRule(name);
            Guid snapshot = store.TakeSnapshot(firewall, command, now);
            ArmIfPartlyApplied(new SafetyNet.Entry { CommandId = command, What = SafetyNet.Kind.Firewall, SnapshotId = snapshot }, () =>
            {
                switch (p.Change)
                {
                    case RuleChange.Create: firewall.CreateRule(p.Rule!); break;
                    case RuleChange.Update: firewall.UpdateRule(name, p.Rule!); break;
                    case RuleChange.Enable: firewall.SetRuleEnabled(name, true); break;
                    case RuleChange.Disable: firewall.SetRuleEnabled(name, false); break;
                    case RuleChange.Delete: firewall.DeleteRule(name); break;
                }
            });
            ReportedFirewallRule? after = p.Change == RuleChange.Delete ? null : firewall.ReadRule(p.Change == RuleChange.Update ? p.Rule!.Name : name);
            store.Record(command, firewall.Read(), now);
            DateTimeOffset deadline = safetyNet.Arm(new SafetyNet.Entry { CommandId = command, What = SafetyNet.Kind.Firewall, SnapshotId = snapshot });
            return new FirewallSetRuleOutput { Change = p.Change, Before = before, After = after, SnapshotId = snapshot, SafetyNetDeadline = deadline };
        }
    }

    public FirewallRestoreOutput Restore(FirewallRestoreParams p)
    {
        Guid command = Command();
        lock (_gate)
        {
            if (!store.HasSnapshot(p.SnapshotId)) throw new OperationFailedException("not_found", "This cabinet has no snapshot with that ID.");
            DateTimeOffset now = clock.GetUtcNow();
            Guid pre = store.TakeSnapshot(firewall, command, now);
            firewall.Import(store.SnapshotPath(p.SnapshotId));
            store.Record(command, firewall.Read(), now);
            DateTimeOffset deadline = safetyNet.Arm(new SafetyNet.Entry { CommandId = command, What = SafetyNet.Kind.Firewall, SnapshotId = pre });
            return new FirewallRestoreOutput { RestoredSnapshotId = p.SnapshotId, PreRestoreSnapshotId = pre, RestoredAt = now, SafetyNetDeadline = deadline };
        }
    }

    private static uint Ipv4(string text)
    {
        if (!System.Net.IPAddress.TryParse(text, out var ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
            throw new OperationFailedException("execution_failed", "Not a valid IPv4 address.");
        return System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(ip.GetAddressBytes());
    }

    private FirewallProfileState WithTimer(FirewallProfileState s) =>
        s with { ReenableAt = store.TimersList().FirstOrDefault(t => t.Profile == s.Profile)?.ReenableAt };

    // ---- Upkeep: the broker runs this every few seconds and once at start-up -----------------

    /// <summary>Rolls back unconfirmed changes whose time is up, and turns profiles back on when their timer ends.</summary>
    public void Tick()
    {
        lock (_gate)
        {
            safetyNet.Expire(Rollback, log);
            foreach (FirewallStore.Timer due in store.TakeDue(clock.GetUtcNow()))
            {
                try
                {
                    FirewallProfileState now = firewall.Read().Profiles.Single(s => s.Profile == due.Profile);
                    firewall.SetProfile(due.Profile, true, now.DefaultInbound, now.DefaultOutbound);
                    store.Record(due.CommandId, firewall.Read(), clock.GetUtcNow());
                    log($"Firewall: the {due.Profile} profile's time limit ended; it is on again.");
                }
                catch (Exception e)
                {
                    // Keep trying: a profile left off is the one thing this timer exists to prevent.
                    store.SetTimer(due.Profile, clock.GetUtcNow().AddSeconds(30), due.CommandId);
                    log($"Firewall: could not turn the {due.Profile} profile back on yet ({e.GetType().Name}); retrying.");
                }
            }
        }
    }

    private void Rollback(SafetyNet.Entry e)
    {
        switch (e.What)
        {
            case SafetyNet.Kind.Network:
                network.Restore(e.InterfaceIndex!.Value, e.IpBefore!);
                network.SetDns(e.InterfaceIndex.Value, e.DnsBefore!);
                break;
            case SafetyNet.Kind.Firewall:
                firewall.Import(store.SnapshotPath(e.SnapshotId!.Value));
                store.ClearTimersFor(e.CommandId);
                store.Record(e.CommandId, firewall.Read(), clock.GetUtcNow());
                break;
        }
    }
}

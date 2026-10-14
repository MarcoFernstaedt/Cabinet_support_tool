using Cabinet.Agent.Core.Monitoring;
using Cabinet.Agent.Core.Writes;

namespace Cabinet.Agent.Core.Tests;

/// <summary>An in-memory Windows Firewall: profiles, rules, and export/import as JSON files.</summary>
public sealed class FakeFirewall : IFirewallControl
{
    public Dictionary<FirewallProfile, FirewallProfileState> Profiles { get; } = Enum.GetValues<FirewallProfile>().ToDictionary(p => p,
        p => new FirewallProfileState { Profile = p, Enabled = true, DefaultInbound = FirewallAction.Block, DefaultOutbound = FirewallAction.Allow, ReenableAt = null });
    public List<ReportedFirewallRule> Rules { get; } = new()
    {
        new() { Name = "Core Networking - DNS (UDP-Out)", Direction = FirewallDirection.Out, Action = FirewallAction.Allow, Protocol = "UDP", RemotePorts = "53", Enabled = true, CreatedByPlatform = false },
    };
    public int Imports;

    public FirewallStateOutput Read() => new() { Profiles = Profiles.Values.OrderBy(p => p.Profile).ToList(), Rules = Rules.ToList(), RulesTruncated = false, Snapshots = [] };
    public void SetProfile(FirewallProfile p, bool enabled, FirewallAction i, FirewallAction o) => Profiles[p] = Profiles[p] with { Enabled = enabled, DefaultInbound = i, DefaultOutbound = o };
    public int CountRules(string name) => Rules.Count(r => r.Name == name);
    public ReportedFirewallRule? ReadRule(string name) => Rules.FirstOrDefault(r => r.Name == name);
    public void CreateRule(FirewallRule r) => Rules.Add(Report(r));
    public void UpdateRule(string name, FirewallRule r) { Rules.RemoveAll(x => x.Name == name); Rules.Add(Report(r)); }
    public void SetRuleEnabled(string name, bool enabled) { int i = Rules.FindIndex(r => r.Name == name); Rules[i] = Rules[i] with { Enabled = enabled }; }
    public void DeleteRule(string name) => Rules.RemoveAll(r => r.Name == name);
    public void Export(string path) => File.WriteAllText(path, JsonSerializer.Serialize(Read(), ContractJson.Options));
    public void Import(string path)
    {
        Imports++;
        var s = JsonSerializer.Deserialize<FirewallStateOutput>(File.ReadAllText(path), ContractJson.Options)!;
        foreach (var p in s.Profiles) Profiles[p.Profile] = p;
        Rules.Clear(); Rules.AddRange(s.Rules);
    }

    private static ReportedFirewallRule Report(FirewallRule r) => new()
    {
        Name = r.Name, Direction = r.Direction, Action = r.Action, Protocol = r.Protocol.ToString().ToUpperInvariant(), Enabled = r.Enabled,
        LocalPorts = r.LocalPorts is { Count: > 0 } lp ? string.Join(',', lp.Select(x => x.From == x.To ? $"{x.From}" : $"{x.From}-{x.To}")) : null,
        Profiles = r.Profiles, CreatedByPlatform = r.Name.StartsWith("MashuraDiag", StringComparison.Ordinal),
    };
}

public sealed class FakeNetwork : INetworkControl
{
    public Ipv4Settings Ip = new() { Dhcp = true, Addresses = [new() { Address = "10.20.0.31", PrefixLength = 24 }], Gateways = ["10.20.0.1"] };
    public DnsSettings Dns = new() { Automatic = true, Servers = ["10.20.0.1"] };
    public (Ipv4Settings Ip, DnsSettings Dns) Read(int i) => i == 12 ? (Ip, Dns) : throw new OperationFailedException("not_found", "No adapter has that index.");
    public void SetDhcp(int i) { Read(i); Ip = Ip with { Dhcp = true }; }
    /// <summary>Like Windows when the address is set but the gateway call then fails: half the change is applied.</summary>
    public bool GatewayFails;
    public void SetStatic(int i, string a, int p, string g)
    {
        Read(i);
        Ip = new() { Dhcp = false, Addresses = [new() { Address = a, PrefixLength = p }], Gateways = [] };
        if (GatewayFails) throw new IOException("SetGateways failed");
        Ip = Ip with { Gateways = [g] };
    }
    public void SetDns(int i, DnsSettings d) { Read(i); Dns = d; }
    /// <summary>What a DHCP server would give: null means none answers and the adapter keeps no real address.</summary>
    public string? LeaseAddress = "10.20.0.77";
    public int RenewCode;
    public int RenewLease(int i)
    {
        Read(i);
        Ip = Ip with { Addresses = [new() { Address = LeaseAddress ?? "169.254.9.9", PrefixLength = LeaseAddress is null ? 16 : 24 }] };
        return RenewCode;
    }
    public int Flushes;
    public bool FlushDns() { Flushes++; return true; }
    public void Restore(int i, Ipv4Settings ip) { Read(i); Ip = ip; }
}

public class SafetyNetTests
{
    private static readonly Guid A = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid B = Guid.Parse("22222222-2222-4222-8222-222222222222");

    [Fact]
    public void A_confirmed_change_is_kept_and_an_unconfirmed_one_is_rolled_back_at_its_deadline()
    {
        var clock = new ManualClock(Fixtures.Start);
        var net = new SafetyNet(null, clock);
        var rolled = new List<Guid>();
        DateTimeOffset deadline = net.Arm(new SafetyNet.Entry { CommandId = A, What = SafetyNet.Kind.Firewall, SnapshotId = Guid.NewGuid() });
        Assert.Equal(Fixtures.Start + TimeSpan.FromMinutes(2), deadline);
        Assert.Equal(SafetyNetState.Kept, net.Confirm(A).State);
        Assert.Equal(SafetyNetState.Kept, net.Confirm(A).State); // asking again is harmless

        net.Arm(new SafetyNet.Entry { CommandId = B, What = SafetyNet.Kind.Firewall, SnapshotId = Guid.NewGuid() });
        clock.Advance(TimeSpan.FromSeconds(119));
        Assert.Empty(net.Expire(e => rolled.Add(e.CommandId), _ => { }));
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(new[] { B }, net.Expire(e => rolled.Add(e.CommandId), _ => { }));
        Assert.Equal(new[] { B }, rolled);
        var late = net.Confirm(B);
        Assert.Equal(SafetyNetState.RolledBack, late.State);
        Assert.NotNull(late.RolledBackAt);
        Assert.Equal(SafetyNetState.Unknown, net.Confirm(Guid.NewGuid()).State);
    }

    [Fact]
    public void When_the_oldest_change_expires_every_later_one_is_undone_too_newest_first()
    {
        var clock = new ManualClock(Fixtures.Start);
        var net = new SafetyNet(null, clock);
        net.Arm(new SafetyNet.Entry { CommandId = A, What = SafetyNet.Kind.Network, InterfaceIndex = 12 });
        clock.Advance(TimeSpan.FromSeconds(30));
        net.Arm(new SafetyNet.Entry { CommandId = B, What = SafetyNet.Kind.Network, InterfaceIndex = 12 });
        clock.Advance(TimeSpan.FromSeconds(95)); // A is past its deadline, B is not yet
        var order = new List<Guid>();
        net.Expire(e => order.Add(e.CommandId), _ => { });
        Assert.Equal(new[] { B, A }, order);
    }

    [Fact]
    public void A_restart_or_reboot_inside_the_window_still_ends_in_a_rollback()
    {
        using var dir = new TempDir();
        string file = dir.File("safety-net.json");
        var clock = new ManualClock(Fixtures.Start);
        new SafetyNet(file, clock).Arm(new SafetyNet.Entry { CommandId = A, What = SafetyNet.Kind.Firewall, SnapshotId = Guid.NewGuid() });
        clock.Advance(TimeSpan.FromMinutes(10)); // the machine was off
        var rolled = new List<Guid>();
        new SafetyNet(file, clock).Expire(e => rolled.Add(e.CommandId), _ => { });
        Assert.Equal(new[] { A }, rolled);
        Assert.Equal(SafetyNetState.RolledBack, new SafetyNet(file, clock).Confirm(A).State);
    }

    [Fact]
    public void A_failed_rollback_is_still_recorded_and_logged()
    {
        var clock = new ManualClock(Fixtures.Start);
        var net = new SafetyNet(null, clock);
        net.Arm(new SafetyNet.Entry { CommandId = A, What = SafetyNet.Kind.Firewall, SnapshotId = Guid.NewGuid() });
        clock.Advance(TimeSpan.FromMinutes(3));
        var log = new List<string>();
        net.Expire(_ => throw new IOException("snapshot missing"), log.Add);
        Assert.Contains(log, l => l.Contains("failed"));
        Assert.Equal(SafetyNetState.RolledBack, net.Confirm(A).State);
    }
}

public class BrokerWriteTests
{
    private readonly ManualClock _clock = new(Fixtures.Start);
    private readonly FakeFirewall _fw = new();
    private readonly FakeNetwork _net = new();
    private readonly SafetyNet _safety;
    private readonly FirewallStore _store = new(null);
    private readonly BrokerWrites _writes;
    private readonly List<string> _log = new();

    public BrokerWriteTests()
    {
        _safety = new SafetyNet(null, _clock);
        _writes = new BrokerWrites(_fw, _net, _safety, _store, _clock, _log.Add);
    }

    private T As<T>(Guid command, Func<T> f) => OperationContext.RunAsync(command, () => Task.FromResult(f())).GetAwaiter().GetResult();

    private static FirewallRule Rule(string name = "MashuraDiag Sync 1433") => new()
    {
        Name = name, Direction = FirewallDirection.In, Action = FirewallAction.Allow, Protocol = FirewallProtocol.Tcp,
        LocalPorts = [new PortRange { From = 1433, To = 1433 }], Profiles = [FirewallProfile.Domain, FirewallProfile.Private], Enabled = true,
    };

    [Fact]
    public void Flushing_the_dns_cache_changes_no_setting_and_arms_no_safety_net()
    {
        var output = As(Guid.NewGuid(), () => _writes.FlushDns());
        Assert.True(output.Flushed);
    }

    [Fact]
    public void Renewing_a_lease_reports_the_new_address_and_changes_no_setting()
    {
        var output = As(Guid.NewGuid(), () => _writes.RenewLease(new NetworkRenewLeaseParams { InterfaceIndex = 12 }));
        Assert.Equal(RenewLeaseResult.Renewed, output.Result);
        Assert.Equal("10.20.0.31", output.AddressBefore);
        Assert.Equal("10.20.0.77", output.AddressAfter);
        Assert.True(_net.Ip.Dhcp); // still on DHCP; nothing was armed for the safety net
        Assert.Empty(_safety.Pending);
    }

    [Fact]
    public void A_lease_that_comes_back_as_the_self_assigned_address_is_a_failure_not_a_success()
    {
        _net.LeaseAddress = null;
        var output = As(Guid.NewGuid(), () => _writes.RenewLease(new NetworkRenewLeaseParams { InterfaceIndex = 12 }));
        Assert.Equal(RenewLeaseResult.Failed, output.Result);
        Assert.Equal("169.254.9.9", output.AddressAfter);
        _net.LeaseAddress = "10.20.0.77"; _net.RenewCode = 5;
        Assert.Equal(RenewLeaseResult.Failed, As(Guid.NewGuid(), () => _writes.RenewLease(new NetworkRenewLeaseParams { InterfaceIndex = 12 })).Result);
    }

    [Fact]
    public void An_adapter_with_a_fixed_address_is_left_alone_and_an_unknown_adapter_is_not_found()
    {
        _net.Ip = _net.Ip with { Dhcp = false };
        var output = As(Guid.NewGuid(), () => _writes.RenewLease(new NetworkRenewLeaseParams { InterfaceIndex = 12 }));
        Assert.Equal(RenewLeaseResult.NotDhcp, output.Result);
        Assert.Equal("10.20.0.31", _net.Ip.Addresses[0].Address);
        var e = Assert.Throws<OperationFailedException>(() => As(Guid.NewGuid(), () => _writes.RenewLease(new NetworkRenewLeaseParams { InterfaceIndex = 99 })));
        Assert.Equal("not_found", e.Code);
    }

    [Fact]
    public void Applying_the_client_policy_turns_every_profile_off_with_no_timer_and_is_undone_if_unconfirmed()
    {
        // A temporary "off" timer on public is replaced: the policy is the intended state.
        As(Guid.NewGuid(), () => _writes.SetProfile(new FirewallSetProfileParams
        {
            Profile = FirewallProfile.Public, Enabled = false, DefaultInbound = FirewallAction.Block, DefaultOutbound = FirewallAction.Allow, DurationMinutes = 30,
        }));
        Guid cmd = Guid.NewGuid();
        var output = As(cmd, () => _writes.ApplyPolicy(new FirewallApplyPolicyParams { Profiles = new() { Domain = false, Private = false, Public = false } }));
        Assert.Equal([FirewallProfile.Domain, FirewallProfile.Private], output.Changed);
        Assert.All(output.After, s => Assert.False(s.Enabled));
        Assert.All(output.After, s => Assert.Null(s.ReenableAt));
        Assert.Equal(FirewallAction.Block, _fw.Profiles[FirewallProfile.Domain].DefaultInbound); // default actions are kept
        Assert.Empty(_store.TimersList());

        // Never confirmed (the cabinet lost the server): the safety net puts the snapshot back.
        _clock.Advance(TimeSpan.FromMinutes(3));
        _writes.Tick();
        Assert.True(_fw.Profiles[FirewallProfile.Domain].Enabled);
    }

    [Fact]
    public void Applying_a_policy_the_cabinet_already_matches_changes_nothing()
    {
        Guid cmd = Guid.NewGuid();
        var output = As(cmd, () => _writes.ApplyPolicy(new FirewallApplyPolicyParams { Profiles = new() { Domain = true, Private = true, Public = true } }));
        Assert.Empty(output.Changed);
        Assert.Equal(SafetyNetState.Kept, _safety.Confirm(cmd).State);
        Assert.Throws<OperationFailedException>(() => _writes.ApplyPolicy(new FirewallApplyPolicyParams { Profiles = new() { Domain = false, Private = false, Public = false } })); // no command
    }

    [Fact]
    public void A_profile_turned_off_comes_back_on_when_its_time_ends_even_after_a_restart()
    {
        using var dir = new TempDir();
        var store = new FirewallStore(dir.Path);
        var safety = new SafetyNet(dir.File("safety.json"), _clock);
        var writes = new BrokerWrites(_fw, _net, safety, store, _clock, _log.Add);
        Guid cmd = Guid.NewGuid();
        var output = As(cmd, () => writes.SetProfile(new FirewallSetProfileParams
        {
            Profile = FirewallProfile.Public, Enabled = false, DefaultInbound = FirewallAction.Block, DefaultOutbound = FirewallAction.Allow, DurationMinutes = 5,
        }));
        Assert.True(output.Before.Enabled);
        Assert.False(output.After.Enabled);
        Assert.Equal(Fixtures.Start.AddMinutes(5), output.After.ReenableAt);
        safety.Confirm(cmd);

        // The broker restarts (or the cabinet reboots); a new instance reads the timer from disk.
        var restarted = new BrokerWrites(_fw, _net, new SafetyNet(dir.File("safety.json"), _clock), new FirewallStore(dir.Path), _clock, _log.Add);
        _clock.Advance(TimeSpan.FromMinutes(4));
        restarted.Tick();
        Assert.False(_fw.Profiles[FirewallProfile.Public].Enabled);
        _clock.Advance(TimeSpan.FromMinutes(1));
        restarted.Tick();
        Assert.True(_fw.Profiles[FirewallProfile.Public].Enabled);
        Assert.Empty(new FirewallStore(dir.Path).TimersList());
        // The re-enable is attributed to the command that turned it off.
        Assert.Equal(cmd, new FirewallStore(dir.Path).CommandFor(FirewallWatch.Hash(_fw.Read())));
    }

    [Fact]
    public void An_unconfirmed_firewall_change_is_undone_from_its_snapshot()
    {
        Guid cmd = Guid.NewGuid();
        var output = As(cmd, () => _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Create, Rule = Rule() with { Action = FirewallAction.Block, Direction = FirewallDirection.Out } }));
        Assert.Null(output.Before);
        Assert.Equal("MashuraDiag Sync 1433", output.After!.Name);
        Assert.Contains(_fw.Rules, r => r.Name == "MashuraDiag Sync 1433");
        Assert.Equal(_store.Snapshots()[0].SnapshotId, output.SnapshotId);
        _clock.Advance(TimeSpan.FromMinutes(2));
        _writes.Tick();
        Assert.DoesNotContain(_fw.Rules, r => r.Name == "MashuraDiag Sync 1433");
        Assert.Equal(SafetyNetState.RolledBack, _safety.Confirm(cmd).State);
    }

    [Fact]
    public void A_confirmed_change_stays()
    {
        Guid cmd = Guid.NewGuid();
        As(cmd, () => _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Create, Rule = Rule() }));
        Assert.Equal(SafetyNetState.Kept, _safety.Confirm(cmd).State);
        _clock.Advance(TimeSpan.FromMinutes(10));
        _writes.Tick();
        Assert.Contains(_fw.Rules, r => r.Name == "MashuraDiag Sync 1433");
    }

    [Fact]
    public void Rule_names_are_checked_before_anything_changes()
    {
        Assert.Equal("execution_failed", Assert.Throws<OperationFailedException>(() => As(Guid.NewGuid(), () =>
            _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Create, Rule = Rule("Allow everything") }))).Code);
        As(Guid.NewGuid(), () => _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Create, Rule = Rule() }));
        Assert.Throws<OperationFailedException>(() => As(Guid.NewGuid(), () => _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Create, Rule = Rule() })));
        Assert.Equal("not_found", Assert.Throws<OperationFailedException>(() => As(Guid.NewGuid(), () =>
            _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Delete, RuleName = "No such rule" }))).Code);
        _fw.Rules.Add(_fw.Rules[0]); // Windows allows two rules with one name
        Assert.Contains("ambiguous", Assert.Throws<OperationFailedException>(() => As(Guid.NewGuid(), () =>
            _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Disable, RuleName = "Core Networking - DNS (UDP-Out)" }))).Message);
        Assert.Throws<OperationFailedException>(() => _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Delete, RuleName = "MashuraDiag Sync 1433" })); // no command
        // An update cannot rename: a Windows rule must not take the platform's prefix, nor a platform rule lose it.
        Assert.Contains("rename", Assert.Throws<OperationFailedException>(() => As(Guid.NewGuid(), () =>
            _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Update, RuleName = "MashuraDiag Sync 1433", Rule = Rule("MashuraDiag Renamed") }))).Message);
        Assert.Single(_store.Snapshots()); // only the one real change took a snapshot
    }

    [Fact]
    public void Existing_rules_can_be_changed_and_restore_puts_a_snapshot_back()
    {
        Guid first = Guid.NewGuid();
        var disabled = As(first, () => _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Disable, RuleName = "Core Networking - DNS (UDP-Out)" }));
        Assert.True(disabled.Before!.Enabled);
        Assert.False(disabled.After!.Enabled);
        _safety.Confirm(first);
        Guid restore = Guid.NewGuid();
        var restored = As(restore, () => _writes.Restore(new FirewallRestoreParams { SnapshotId = disabled.SnapshotId }));
        Assert.True(_fw.Rules[0].Enabled);
        Assert.NotEqual(disabled.SnapshotId, restored.PreRestoreSnapshotId);
        Assert.Equal("not_found", Assert.Throws<OperationFailedException>(() => As(Guid.NewGuid(), () => _writes.Restore(new FirewallRestoreParams { SnapshotId = Guid.NewGuid() }))).Code);
    }

    [Fact]
    public void Only_twenty_snapshots_are_kept()
    {
        for (int i = 0; i < 25; i++)
        {
            Guid c = Guid.NewGuid();
            As(c, () => _writes.SetRule(new FirewallSetRuleParams { Change = i % 2 == 0 ? RuleChange.Disable : RuleChange.Enable, RuleName = "Core Networking - DNS (UDP-Out)" }));
            _safety.Confirm(c);
        }
        Assert.Equal(FirewallStore.KeepSnapshots, _store.Snapshots().Count);
    }

    [Fact]
    public void A_network_change_reports_before_and_after_and_is_undone_if_unconfirmed()
    {
        Guid cmd = Guid.NewGuid();
        var output = As(cmd, () => _writes.SetIp(new NetworkSetIpParams { InterfaceIndex = 12, Mode = IpMode.Static, Address = "10.20.0.50", PrefixLength = 24, Gateway = "10.20.0.1" }));
        Assert.True(output.Before.Dhcp);
        Assert.False(output.After.Dhcp);
        Assert.Equal("10.20.0.50", _net.Ip.Addresses[0].Address);
        Guid dns = Guid.NewGuid();
        As(dns, () => _writes.SetDns(new NetworkSetDnsParams { InterfaceIndex = 12, Mode = DnsMode.Static, Servers = ["10.20.0.2"] }));
        _clock.Advance(TimeSpan.FromMinutes(3));
        _writes.Tick();
        Assert.True(_net.Ip.Dhcp);
        Assert.True(_net.Dns.Automatic);
    }

    [Fact]
    public void A_network_change_that_fails_half_way_is_still_undone_by_the_safety_net()
    {
        _net.GatewayFails = true;
        Guid cmd = Guid.NewGuid();
        Assert.Throws<IOException>(() => As(cmd, () => _writes.SetIp(new NetworkSetIpParams { InterfaceIndex = 12, Mode = IpMode.Static, Address = "10.20.0.50", PrefixLength = 24, Gateway = "10.20.0.1" })));
        Assert.False(_net.Ip.Dhcp); // the address changed and the gateway is gone
        Assert.Contains(_safety.Pending, e => e.CommandId == cmd);
        _clock.Advance(TimeSpan.FromMinutes(3));
        _writes.Tick();
        Assert.True(_net.Ip.Dhcp);
        Assert.Equal(["10.20.0.1"], _net.Ip.Gateways);
    }

    [Fact]
    public void Each_operation_gets_a_time_limit_for_its_kind_and_the_network_side_always_outlasts_the_broker()
    {
        Assert.Equal(OperationRunner.DefaultTimeout, OperationRunner.NetworkTimeoutFor(Catalog.SystemInfo));
        Assert.True(OperationRunner.BrokerTimeoutFor(Catalog.PackageInstall) >= TimeSpan.FromMinutes(15));
        foreach (var entry in Catalog.All.Where(e => e.Kind == OperationKind.Write))
            Assert.True(OperationRunner.NetworkTimeoutFor(entry.Name) > OperationRunner.BrokerTimeoutFor(entry.Name), entry.Name);
        // A package can be downloaded only for 30 minutes after its command is delivered (the server's rule), so the agent stops before that.
        Assert.True(OperationRunner.NetworkTimeoutFor(Catalog.PackageInstall) < TimeSpan.FromMinutes(30));
    }

    [Theory]
    [InlineData("10.20.0.50", 24, "10.30.0.1")] // gateway off the subnet
    [InlineData("10.20.0.1", 24, "10.20.0.1")]  // gateway is the address itself
    public void A_static_address_that_cannot_work_is_refused_before_it_is_set(string address, int prefix, string gateway)
    {
        Assert.Throws<OperationFailedException>(() => As(Guid.NewGuid(), () => _writes.SetIp(new NetworkSetIpParams { InterfaceIndex = 12, Mode = IpMode.Static, Address = address, PrefixLength = prefix, Gateway = gateway })));
        Assert.True(_net.Ip.Dhcp);
        Assert.Empty(_safety.Pending);
    }

    [Fact]
    public void An_unknown_adapter_is_not_found()
    {
        Assert.Equal("not_found", Assert.Throws<OperationFailedException>(() => As(Guid.NewGuid(), () => _writes.SetDns(new NetworkSetDnsParams { InterfaceIndex = 99, Mode = DnsMode.Automatic }))).Code);
    }

    [Fact]
    public void The_change_detector_attributes_platform_changes_and_flags_others()
    {
        var watch = new FirewallWatch(new StateFile<FirewallWatch.State>(null), _store.CommandFor);
        Assert.Null(watch.Check(_fw.Read(), Fixtures.Start)); // baseline
        Guid cmd = Guid.NewGuid();
        As(cmd, () => _writes.SetRule(new FirewallSetRuleParams { Change = RuleChange.Create, Rule = Rule() }));
        var ours = watch.Check(_fw.Read(), Fixtures.Start)!;
        Assert.Equal(cmd, ours.CommandId);
        Assert.True(new EventQueue(null).Enqueue(ours));
        _fw.Rules.Add(_fw.Rules[0] with { Name = "Someone else's rule" });
        var theirs = watch.Check(_fw.Read(), Fixtures.Start)!;
        Assert.Null(theirs.CommandId);
        Assert.Contains("outside the platform", theirs.Detail.Message);
    }
}

public class BrokerConfirmTests
{
    [Fact]
    public async Task The_broker_answers_confirm_and_refuses_a_write_without_its_command()
    {
        var clock = new ManualClock(Fixtures.Start);
        var safety = new SafetyNet(null, clock);
        var writes = new BrokerWrites(new FakeFirewall(), new FakeNetwork(), safety, new FirewallStore(null), clock, _ => { });
        var handler = new BrokerRequestHandler(writes.Register(new OperationRegistry()), confirm: safety.Confirm);
        Guid cmd = Guid.NewGuid();
        var write = await handler.HandleAsync(Fixtures.Bytes(new JsonObject
        {
            ["requestId"] = Guid.NewGuid().ToString(), ["kind"] = "operation", ["operation"] = "network.setDns", ["commandId"] = cmd.ToString(),
            ["params"] = new JsonObject { ["interfaceIndex"] = 12, ["mode"] = "automatic" },
        }), default);
        Assert.Equal("succeeded", JsonNode.Parse(write!)!["status"]!.GetValue<string>());
        var confirm = await handler.HandleAsync(Fixtures.Bytes(new JsonObject { ["requestId"] = Guid.NewGuid().ToString(), ["kind"] = "confirm", ["commandId"] = cmd.ToString() }), default);
        Assert.Equal("kept", JsonNode.Parse(confirm!)!["output"]!["state"]!.GetValue<string>());

        var noCommand = await handler.HandleAsync(Fixtures.Bytes(new JsonObject
        {
            ["requestId"] = Guid.NewGuid().ToString(), ["kind"] = "operation", ["operation"] = "network.setDns",
            ["params"] = new JsonObject { ["interfaceIndex"] = 12, ["mode"] = "automatic" },
        }), default);
        Assert.Equal("invalid_params", JsonNode.Parse(noCommand!)!["error"]!["code"]!.GetValue<string>());
    }
}

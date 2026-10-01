using System.Text.Json;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Connectivity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Tests;

public sealed class FirewallReaderTests
{
    [Theory]
    [InlineData(0, true)]
    [InlineData(1, false)]
    public void Automatic_check_reports_only_a_source_outbound_profile_clue(int action, bool expected)
    {
        var native = new ScriptedGateway { ProfileRead = p => new() { Profile = p, Status = FirewallReadStatus.Read,
            Enabled = true, DefaultOutboundAction = action } };
        var checkedAt = DateTimeOffset.UtcNow;
        var result = new WindowsSourceFirewallCheck(new FirewallReader(native)).Read(checkedAt, default);
        Assert.Equal(expected, result.HasOutboundProfileBlockClue);
        Assert.True(result.ObservedUtc >= checkedAt.AddSeconds(-1));
        Assert.Equal(0, native.RuleCalls);
        Assert.True(native.Disposed);
    }

    [Fact]
    public async Task Source_check_refuses_overlapping_native_reads_across_sampler_lifetimes()
    {
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var native = new ScriptedGateway { ProfileRead = p =>
        {
            if (p == 1) { entered.Set(); release.Wait(TimeSpan.FromSeconds(3)); }
            return new FirewallProfileObservation { Profile = p, Status = FirewallReadStatus.Read,
                Enabled = true, DefaultOutboundAction = 1 };
        } };
        var check = new WindowsSourceFirewallCheck(new FirewallReader(native));
        var first = Task.Run(() => check.Read(DateTimeOffset.UtcNow, default));
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(2)));
            var second = await Task.Run(() => check.Read(DateTimeOffset.UtcNow, default)).WaitAsync(TimeSpan.FromSeconds(1));
            Assert.Equal(FirewallReadStatus.Unavailable, second.Status);
        }
        finally { release.Set(); await first; }
    }

    [Fact]
    public void Automatic_check_keeps_missing_active_profile_unknown()
    {
        var native = new ScriptedGateway { ProfileRead = p => p == 1
            ? throw new UnauthorizedAccessException("Synthetic access denied")
            : new() { Profile = p, Status = FirewallReadStatus.Read,
                Enabled = true, DefaultOutboundAction = 1 } };
        var result = new WindowsSourceFirewallCheck(new FirewallReader(native)).Read(DateTimeOffset.UtcNow, default);
        Assert.Null(result.HasOutboundProfileBlockClue);
        Assert.Equal(FirewallReadStatus.Partial, result.Status);
    }

    [Fact]
    public async Task Fixed_read_returns_profiles_and_bounded_rules_through_agent_json()
    {
        var native = new Native();
        var outcome = await new InspectFirewallExecutor(new FirewallReader(native)).ExecuteAsync(
            new ActionRequestDto { Id = Guid.NewGuid(), CabinetId = Guid.NewGuid(), Reason = "Synthetic inspection", RequestedByUserId = Guid.NewGuid(), RequestedUtc = DateTimeOffset.UtcNow, Action = ActionName.InspectFirewall }, default);
        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        var result = JsonSerializer.Deserialize<FirewallInspection>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        Assert.Equal(FirewallReadStatus.Read, result.Status);
        Assert.Equal(new[] { 1, 2, 4 }, result.Profiles.Select(p => p.Profile));
        Assert.Equal(128, result.Rules.Count);
        Assert.True(result.RulesTruncated);
        Assert.Equal(128, native.RowsRead);
        Assert.True(native.Disposed);
        Assert.Contains("not", result.PolicyCaveat);
        Assert.Equal(1, result.ActiveProfiles);
        Assert.Equal(0, result.LocalPolicyModifyState);
    }

    [Fact]
    public void Native_adapter_reads_indexed_COM_properties_without_setters()
    {
        var result = new FirewallReader(new WindowsFirewallGateway(() => new FakePolicy())).Read(default);
        Assert.Equal(FirewallReadStatus.Read, result.Status);
        Assert.Equal(3, result.ActiveProfiles);
        Assert.All(result.Profiles, p => Assert.True(p.Enabled));
        var row = Assert.Single(result.Rules);
        Assert.Equal("Synthetic native rule", row.Name);
        Assert.Equal("443", row.LocalPorts);
        Assert.Equal(6, row.Protocol);
    }

    public sealed class FakePolicy
    {
        public int CurrentProfileTypes => 3;
        public int LocalPolicyModifyState => 0;
        public bool[] FirewallEnabled => new[] { false, true, true, false, true };
        public bool[] BlockAllInboundTraffic => new bool[5];
        public int[] DefaultInboundAction => new int[5];
        public int[] DefaultOutboundAction => new[] { 0, 1, 1, 0, 1 };
        public object[] Rules => new object[] { new FakeRule() };
    }

    public sealed class FakeRule
    {
        public string Name => "Synthetic native rule";
        public bool Enabled => true;
        public int Profiles => 3;
        public int Direction => 1;
        public int Action => 1;
        public int Protocol => 6;
        public string LocalPorts => "443";
        public string RemotePorts => "*";
        public string LocalAddresses => "*";
        public string RemoteAddresses => "10.0.0.2";
    }

    [Fact]
    public void Cancellation_during_last_native_read_is_not_reported_as_success()
    {
        using var cancel = new CancellationTokenSource();
        var native = new ScriptedGateway
        {
            Rows = Enumerable.Range(0, 128).Select(i =>
            {
                if (i == 127) cancel.Cancel();
                return new FirewallRuleObservation { Name = "Synthetic" };
            })
        };
        Assert.Throws<OperationCanceledException>(() => new FirewallReader(native).Read(cancel.Token));
        Assert.True(native.Disposed);
    }

    [Fact]
    public void Display_text_is_bounded_and_strips_control_and_bidi_formatting()
    {
        var native = new ScriptedGateway
        {
            Rows = new[] { new FirewallRuleObservation { Name = "<tag>\n\u202E" + new string('x', 1000) } }
        };
        var result = new FirewallReader(native).Read(default);
        Assert.True(result.TextTruncated);
        var name = Assert.Single(result.Rules).Name;
        Assert.True(name.Length <= 256);
        Assert.DoesNotContain("\u202E", name, StringComparison.Ordinal);
        Assert.DoesNotContain("\n", name, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("denied", FirewallReadStatus.AccessDenied)]
    [InlineData("com-denied", FirewallReadStatus.AccessDenied)]
    [InlineData("unavailable", FirewallReadStatus.Unavailable)]
    [InlineData("unsupported", FirewallReadStatus.Unsupported)]
    public void Failed_native_open_has_no_healthy_defaults_or_exception_detail(string kind, FirewallReadStatus expected)
    {
        var gateway = new FailingGateway(kind);
        var result = new FirewallReader(gateway).Read(default);
        Assert.Equal(expected, result.Status);
        Assert.Null(result.ActiveProfiles);
        Assert.Null(result.LocalPolicyModifyState);
        Assert.Empty(result.Profiles);
        Assert.Empty(result.Rules);
        Assert.True(result.RulesTruncated);
        Assert.DoesNotContain("private native detail", JsonSerializer.Serialize(result));
    }

    [Fact]
    public void Profile_denial_does_not_hide_other_profile_observations()
    {
        var native = new ScriptedGateway { ProfileRead = p => p == 2
            ? throw new UnauthorizedAccessException("private native detail")
            : new() { Profile = p, Status = FirewallReadStatus.Read, Enabled = true } };
        var result = new FirewallReader(native).Read(default);
        Assert.Equal(FirewallReadStatus.Partial, result.Status);
        Assert.Equal(3, result.Profiles.Count);
        Assert.Equal(FirewallReadStatus.AccessDenied, result.Profiles[1].Status);
        Assert.Null(result.Profiles[1].Enabled);
        Assert.True(result.Profiles[2].Enabled);
        Assert.True(native.Disposed);
    }

    [Fact]
    public void Cooperative_budget_stops_further_profile_and_rule_reads()
    {
        var time = new ManualTime();
        var native = new ScriptedGateway { ProfileRead = p =>
        {
            time.Seconds = 3;
            return new() { Profile = p, Status = FirewallReadStatus.Read };
        } };
        var result = new FirewallReader(native, time).Read(default);
        Assert.Equal(FirewallReadStatus.Partial, result.Status);
        Assert.Single(result.Profiles);
        Assert.Empty(result.Rules);
        Assert.True(result.RulesTruncated);
        Assert.True(native.Disposed);
    }

    [Fact]
    public async Task Extra_operands_are_denied_before_any_native_open()
    {
        var native = new Native();
        var outcome = await new InspectFirewallExecutor(new FirewallReader(native)).ExecuteAsync(new()
        {
            Id = Guid.NewGuid(), CabinetId = Guid.NewGuid(), Reason = "Synthetic invalid input",
            RequestedByUserId = Guid.NewGuid(), RequestedUtc = DateTimeOffset.UtcNow, Action = ActionName.InspectFirewall,
            Parameters = new Dictionary<string, string> { ["enable"] = "false" }
        }, default);
        Assert.Equal(ActionStatus.Denied, outcome.Status);
        Assert.Equal(0, native.RowsRead);
        Assert.False(native.Disposed);
    }

    private sealed class ManualTime : TimeProvider
    {
        public int Seconds;
        public override long TimestampFrequency => 1;
        public override long GetTimestamp() => Seconds;
    }

    private sealed class FailingGateway(string kind) : IFirewallGateway
    {
        public IFirewallSession Open() => throw kind switch
        {
            "denied" => new UnauthorizedAccessException("private native detail"),
            "com-denied" => new System.Runtime.InteropServices.COMException("private native detail", unchecked((int)0x80070005)),
            "unsupported" => new PlatformNotSupportedException("private native detail"),
            _ => new InvalidOperationException("private native detail")
        };
    }

    private sealed class ScriptedGateway : IFirewallGateway, IFirewallSession
    {
        public Func<int, FirewallProfileObservation> ProfileRead { get; init; } = p => new() { Profile = p, Status = FirewallReadStatus.Read };
        public IEnumerable<FirewallRuleObservation> Rows { get; init; } = Array.Empty<FirewallRuleObservation>();
        public bool Disposed;
        public int RuleCalls;
        public IFirewallSession Open() => this;
        public int ActiveProfiles => 1;
        public int LocalPolicyModifyState => 0;
        public FirewallProfileObservation ReadProfile(int profile) => ProfileRead(profile);
        public IEnumerable<FirewallRuleObservation> ReadRules() { RuleCalls++; return Rows; }
        public void Dispose() => Disposed = true;
    }

    internal sealed class Native : IFirewallGateway, IFirewallSession
    {
        public int RowsRead;
        public bool Disposed;
        public IFirewallSession Open() => this;
        public int ActiveProfiles => 1;
        public int LocalPolicyModifyState => 0;
        public FirewallProfileObservation ReadProfile(int profile) => new()
        {
            Profile = profile, Status = FirewallReadStatus.Read, Enabled = true,
            BlockAllInbound = false, DefaultInboundAction = 0, DefaultOutboundAction = 1
        };
        public IEnumerable<FirewallRuleObservation> ReadRules()
        {
            for (int i = 0; i < 1000; i++)
            {
                RowsRead++;
                yield return new() { Name = "Synthetic rule " + i, Enabled = true, Profiles = 1,
                    Direction = 1, Action = 1, Protocol = 6, LocalPorts = "443", RemoteAddresses = "10.0.0.2" };
            }
        }
        public void Dispose() => Disposed = true;
    }
}

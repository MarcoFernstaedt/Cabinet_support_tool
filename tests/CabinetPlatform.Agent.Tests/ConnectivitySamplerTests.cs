using CabinetPlatform.Agent.Connectivity;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Tests;

public sealed class ConnectivitySamplerTests
{
    [Fact]
    public async Task Three_failed_sync_probes_collect_one_read_only_source_firewall_check_per_failure_run()
    {
        var now = DateTimeOffset.UtcNow.AddMinutes(-9);
        var source = Guid.NewGuid(); var saved = new List<ConnectivitySummary>();
        var reader = new RecordingFirewallCheck();
        var sampler = new ConnectivitySampler(source, new SequenceProbe(
            ProbeObservation.NoReply, ProbeObservation.NoReply, ProbeObservation.NoReply,
            ProbeObservation.NoReply, ProbeObservation.NoReply, ProbeObservation.NoReply,
            ProbeObservation.Reply, ProbeObservation.NoReply, ProbeObservation.NoReply, ProbeObservation.NoReply),
            s => { saved.Add(s); return true; }, reader);
        var plan = Plan(source, now);
        sampler.ApplyPlan(plan, now);
        for (int i = 0; i < 12; i++)
        {
            if (i == 8) sampler.ApplyPlan(plan with { IssuedUtc = now.AddMinutes(8), ExpiresUtc = now.AddMinutes(18) }, now.AddMinutes(8));
            await sampler.SampleAsync(now.AddMinutes(i), default);
        }
        Assert.Equal(2, reader.Calls);
        Assert.True(saved[0].SourceFirewallCheck!.HasOutboundProfileBlockClue);
        Assert.Null(saved[1].SourceFirewallCheck);
        Assert.True(saved[3].SourceFirewallCheck!.HasOutboundProfileBlockClue);
    }

    private sealed class RecordingFirewallCheck : ISourceFirewallCheck
    {
        public int Calls { get; private set; }
        public SourceFirewallCheck Read(DateTimeOffset observedUtc, CancellationToken ct)
        {
            Calls++;
            return new SourceFirewallCheck { ObservedUtc = observedUtc, Status = FirewallReadStatus.Read,
                HasOutboundProfileBlockClue = true };
        }
    }

    [Fact]
    public async Task Slow_native_firewall_read_does_not_stall_the_probe_schedule()
    {
        var now = DateTimeOffset.UtcNow.AddMinutes(-8);
        var source = Guid.NewGuid();
        var saved = new List<ConnectivitySummary>();
        var native = new BlockingFirewallCheck();
        var sampler = new ConnectivitySampler(source, new SequenceProbe(
            ProbeObservation.NoReply, ProbeObservation.NoReply, ProbeObservation.NoReply,
            ProbeObservation.Reply, ProbeObservation.NoReply, ProbeObservation.NoReply,
            ProbeObservation.NoReply, ProbeObservation.NoReply, ProbeObservation.NoReply),
            s => { saved.Add(s); return true; }, native, TimeSpan.FromMilliseconds(25));
        sampler.ApplyPlan(Plan(source, now), now);
        try
        {
            for (int i = 0; i < 9; i++)
                await sampler.SampleAsync(now.AddMinutes(i), default).WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal(3, saved.Count);
            Assert.Equal(FirewallReadStatus.Unavailable, saved[0].SourceFirewallCheck?.Status);
            Assert.Equal(FirewallReadStatus.Unavailable, saved[2].SourceFirewallCheck?.Status);
            Assert.Equal(1, native.Calls);
        }
        finally { native.Release(); }
    }

    private sealed class BlockingFirewallCheck : ISourceFirewallCheck
    {
        private readonly ManualResetEventSlim _release = new();
        public int Calls;
        public SourceFirewallCheck Read(DateTimeOffset observedUtc, CancellationToken ct)
        {
            Interlocked.Increment(ref Calls);
            _release.Wait(TimeSpan.FromSeconds(3));
            return new() { ObservedUtc = observedUtc, Status = FirewallReadStatus.Read };
        }
        public void Release() => _release.Set();
    }

    [Fact]
    public void Shipping_agent_does_not_register_peer_sampling_worker_even_when_an_old_plan_exists()
    {
        var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
        CabinetPlatform.Agent.AgentServiceRegistration.AddCabinetAgent(services,
            new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build());
        Assert.DoesNotContain(services, s => s.ServiceType == typeof(Microsoft.Extensions.Hosting.IHostedService) &&
            s.ImplementationType?.Name == "ConnectivityWorker");
        Assert.Contains(services, s => s.ServiceType == typeof(ISourceFirewallCheck) &&
            s.ImplementationType == typeof(WindowsSourceFirewallCheck));
    }

    [Fact]
    public async Task Failed_interval_persistence_does_not_grow_counters_beyond_the_next_three_sample_window()
    {
        var now = DateTimeOffset.UtcNow.AddMinutes(-6);
        var source = Guid.NewGuid();
        int attempts = 0;
        var saved = new List<ConnectivitySummary>();
        var sampler = new ConnectivitySampler(source, new SequenceProbe(ProbeObservation.NoReply), summary =>
        {
            if (++attempts == 1) return false;
            saved.Add(summary);
            return true;
        });
        sampler.ApplyPlan(Plan(source, now), now);
        await sampler.SampleAsync(now, default);
        await sampler.SampleAsync(now.AddMinutes(1), default);
        await Assert.ThrowsAsync<IOException>(() => sampler.SampleAsync(now.AddMinutes(2), default));
        for (int i = 3; i < 6; i++) await sampler.SampleAsync(now.AddMinutes(i), default);
        Assert.Equal(3, Assert.Single(saved).FailureCount);
    }

    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("127.0.0.1")]
    [InlineData("169.254.169.254")]
    [InlineData("224.0.0.1")]
    [InlineData("0.0.0.0")]
    [InlineData("192.168.1.255")]
    [InlineData("192.168.1.0")]
    [InlineData("::1")]
    [InlineData("::ffff:192.168.1.10")]
    [InlineData("cabinet.example")]
    [InlineData(" 192.168.1.10")]
    [InlineData("0xC0A8010A")]
    public async Task Unsafe_or_noncanonical_targets_are_refused_before_any_probe(string address)
    {
        var now = DateTimeOffset.UtcNow;
        var source = Guid.NewGuid();
        var probe = new SequenceProbe(ProbeObservation.Reply);
        var sampler = new ConnectivitySampler(source, probe, _ => true);
        var plan = Plan(source, now);
        sampler.ApplyPlan(plan with { Targets = [plan.Targets[0] with { Address = address }] }, now);
        await sampler.SampleAsync(now, default);
        Assert.Equal(0, probe.Calls);
    }

    [Theory]
    [InlineData("expired")]
    [InlineData("wrong-source")]
    [InlineData("too-many")]
    [InlineData("fast")]
    [InlineData("long-lease")]
    [InlineData("duplicate")]
    [InlineData("unknown-version")]
    public async Task Invalid_or_expired_plan_revokes_cached_targets(string kind)
    {
        var now = DateTimeOffset.UtcNow;
        var source = Guid.NewGuid();
        var probe = new SequenceProbe(ProbeObservation.Reply);
        var sampler = new ConnectivitySampler(source, probe, _ => true);
        var plan = Plan(source, now);
        sampler.ApplyPlan(plan, now);
        plan = kind switch
        {
            "expired" => plan with { ExpiresUtc = now },
            "wrong-source" => plan with { SourceCabinetId = Guid.NewGuid() },
            "too-many" => plan with { Targets = Enumerable.Repeat(plan.Targets[0], 5).ToArray() },
            "fast" => plan with { IntervalSeconds = 1 },
            "long-lease" => plan with { ExpiresUtc = now.AddHours(1) },
            "duplicate" => plan with { Targets = [plan.Targets[0], plan.Targets[0]] },
            _ => plan with { Version = 2 }
        };
        sampler.ApplyPlan(plan, now);
        await sampler.SampleAsync(now, default);
        Assert.Equal(0, probe.Calls);
    }

    [Fact]
    public async Task Expiry_and_local_errors_never_become_remote_failure_evidence()
    {
        var now = DateTimeOffset.UtcNow;
        var source = Guid.NewGuid();
        var probe = new SequenceProbe(ProbeObservation.NoReply, ProbeObservation.Error, ProbeObservation.NoReply);
        var summaries = new List<ConnectivitySummary>();
        var sampler = new ConnectivitySampler(source, probe, s => { summaries.Add(s); return true; });
        sampler.ApplyPlan(Plan(source, now), now);
        for (int i = 0; i < 3; i++) await sampler.SampleAsync(now.AddMinutes(i), default);
        var summary = Assert.Single(summaries);
        Assert.Equal(1, summary.ErrorCount);
        Assert.Equal(1, summary.MaximumFailureRun);
        await sampler.SampleAsync(now.AddMinutes(10), default);
        Assert.Equal(3, probe.Calls);
    }

    [Fact]
    public async Task Nominal_minute_timer_jitter_does_not_skip_every_other_sample()
    {
        var now = DateTimeOffset.UtcNow;
        var source = Guid.NewGuid();
        var saved = new List<ConnectivitySummary>();
        var sampler = new ConnectivitySampler(source, new SequenceProbe(ProbeObservation.Reply), s => { saved.Add(s); return true; });
        sampler.ApplyPlan(Plan(source, now), now);
        await sampler.SampleAsync(now, default);
        await sampler.SampleAsync(now.AddSeconds(59.99), default);
        await sampler.SampleAsync(now.AddSeconds(119.99), default);
        Assert.Equal(3, Assert.Single(saved).SuccessCount);
    }

    [Fact]
    public async Task Backward_clock_before_authorization_does_not_probe_under_a_future_lease()
    {
        var now = DateTimeOffset.UtcNow;
        var source = Guid.NewGuid();
        var probe = new SequenceProbe(ProbeObservation.Reply);
        var sampler = new ConnectivitySampler(source, probe, _ => true);
        sampler.ApplyPlan(Plan(source, now), now);
        await sampler.SampleAsync(now.AddMinutes(-5), default);
        Assert.Equal(0, probe.Calls);
    }

    [Fact]
    public async Task Minute_probes_emit_only_three_sample_raw_summaries_not_individual_events()
    {
        var source = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow.AddMinutes(-5);
        var probe = new SequenceProbe(ProbeObservation.NoReply, ProbeObservation.NoReply, ProbeObservation.NoReply,
            ProbeObservation.Reply, ProbeObservation.Reply, ProbeObservation.Reply);
        var summaries = new List<ConnectivitySummary>();
        var sampler = new ConnectivitySampler(source, probe, s => { summaries.Add(s); return true; });
        sampler.ApplyPlan(Plan(source, now), now);
        await sampler.SampleAsync(now, default);
        await sampler.SampleAsync(now.AddSeconds(20), default);
        Assert.Empty(summaries);
        Assert.Equal(1, probe.Calls);
        await sampler.SampleAsync(now.AddMinutes(1), default);
        Assert.Empty(summaries);
        await sampler.SampleAsync(now.AddMinutes(2), default);
        var failed = Assert.Single(summaries);
        Assert.Equal(3, failed.FailureCount);
        Assert.Equal(3, failed.MaximumFailureRun);
        Assert.Null(failed.LastSuccessUtc);
        for (var i = 3; i < 6; i++) await sampler.SampleAsync(now.AddMinutes(i), default);
        Assert.Equal(2, summaries.Count);
        Assert.Equal(3, summaries[1].SuccessCount);
        Assert.Equal(0, summaries[1].FailureCount);
        Assert.Equal(now.AddMinutes(5), summaries[1].LastSuccessUtc);
    }

    internal static ConnectivityPlan Plan(Guid source, DateTimeOffset now) => new()
    {
        ConfigurationId = Guid.NewGuid(), SourceCabinetId = source, SiteId = Guid.NewGuid(),
        IssuedUtc = now, ExpiresUtc = now.AddMinutes(10),
        Targets = [new ConnectivityTarget { CabinetId = Guid.NewGuid(), Address = "192.168.50.20", IsSync = true }]
    };

    internal sealed class SequenceProbe(params ProbeObservation[] values) : IConnectivityProbe
    {
        public int Calls { get; private set; }
        public Task<ProbeObservation> ProbeAsync(string address, CancellationToken ct) => Task.FromResult(values[Calls++ % values.Length]);
    }
}

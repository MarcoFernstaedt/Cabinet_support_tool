using CabinetPlatform.Server.Actions;

namespace CabinetPlatform.Server.Tests;

/// <summary>Design-stage policy tests. None of these inputs authorize or execute a repair.</summary>
public sealed class FirewallRepairPolicyTests
{
    [Theory]
    [InlineData("CabinetSupport.Sync", "10.0.0.1", "10.0.0.2", 443, 6, 1, true)]
    [InlineData("CabinetSupport.Sync", "10.0.0.1", "10.0.0.2", 443, 17, 2, true)]
    [InlineData("*", "10.0.0.1", "10.0.0.2", 443, 6, 1, false)]
    [InlineData("CabinetSupport.Sync", "*", "10.0.0.2", 443, 6, 1, false)]
    [InlineData("CabinetSupport.Sync", "10.0.0.1", "10.0.0.0/24", 443, 6, 1, false)]
    [InlineData("CabinetSupport.Sync", "10.0.0.1", "8.8.8.8", 443, 6, 1, false)]
    [InlineData("CabinetSupport.Sync", "10.0.0.1", "10.0.0.2", 0, 6, 1, false)]
    [InlineData("CabinetSupport.Sync", "10.0.0.1", "10.0.0.2", 65536, 6, 1, false)]
    [InlineData("CabinetSupport.Sync", "10.0.0.1", "10.0.0.2", 443, 256, 1, false)]
    [InlineData("CabinetSupport.Sync", "10.0.0.1", "10.0.0.2", 443, 6, 4, false)]
    [InlineData("CabinetSupport.Sync", "10.0.0.1", "010.000.000.002", 443, 6, 1, false)]
    [InlineData("CabinetSupport.Sync", "10.0.0.1", "10.0.0.255", 443, 6, 1, false)]
    public void Proposed_scope_is_one_owned_name_exact_private_IPs_single_port_protocol_and_profile(
        string name, string local, string remote, int port, int protocol, int profile, bool valid)
    {
        var scope = new FirewallRuleScopeDraft(name, local, remote, port, protocol, profile);
        Assert.Equal(valid, scope.IsNarrow);
    }

    private static readonly DateTimeOffset Now = new(2026, 9, 19, 20, 0, 0, TimeSpan.Zero);
    private static readonly Guid Site = Guid.Parse("10000000-0000-0000-0000-000000000001");
    private static readonly Guid Cabinet = Guid.Parse("20000000-0000-0000-0000-000000000001");
    private static FirewallRepairPolicyDraft ApprovedPolicy => new()
    {
        SiteId = Site, CabinetId = Cabinet, Revision = "site-policy-v1", ManualRepairEnabled = true,
        AutomaticRepairEnabled = true, ApprovalReference = "approved-lab-only", ValidUntilUtc = Now.AddHours(1),
        Scope = new("CabinetSupport.Sync", "10.0.0.1", "10.0.0.2", 443, 6, 1)
    };
    private static FirewallRepairEvidence Evidence => new()
    {
        SiteId = Site, CabinetId = Cabinet, PolicyRevision = "site-policy-v1", ObservedUtc = Now,
        SiteAuthorizationVerified = true, RegisteredSiteAddressesVerified = true,
        OperatorApprovalVerified = true, PreapprovalVerified = true, ExactOwnedRuleDriftVerified = true,
        EffectiveLocalPolicyVerified = true, DurablePriorStateVerified = true, IndependentRecoveryVerified = true,
        PostVerificationReady = true, ConsecutiveFailures = 3
    };

    [Theory]
    [InlineData("site", "site-or-cabinet-mismatch")]
    [InlineData("cabinet", "site-or-cabinet-mismatch")]
    [InlineData("revision", "policy-revision-mismatch")]
    [InlineData("authorization", "site-authorization-missing")]
    [InlineData("addresses", "site-addresses-unverified")]
    [InlineData("preapproval", "automatic-preapproval-missing")]
    [InlineData("drift", "exact-rule-drift-unverified")]
    [InlineData("gpo", "effective-policy-unverified-or-managed")]
    [InlineData("prior-state", "durable-prior-state-missing")]
    [InlineData("recovery", "independent-recovery-missing")]
    [InlineData("post-verification", "post-verification-missing")]
    [InlineData("stale", "inspection-stale-or-future")]
    [InlineData("future", "inspection-stale-or-future")]
    [InlineData("failures", "failure-threshold-not-met")]
    [InlineData("cooldown", "cooldown-active")]
    public void Every_missing_safeguard_blocks_a_preapproved_automatic_preview(string defect, string blocker)
    {
        var evidence = defect switch
        {
            "site" => Evidence with { SiteId = Guid.NewGuid() },
            "cabinet" => Evidence with { CabinetId = Guid.NewGuid() },
            "revision" => Evidence with { PolicyRevision = "different" },
            "authorization" => Evidence with { SiteAuthorizationVerified = false },
            "addresses" => Evidence with { RegisteredSiteAddressesVerified = false },
            "preapproval" => Evidence with { PreapprovalVerified = false },
            "drift" => Evidence with { ExactOwnedRuleDriftVerified = false },
            "gpo" => Evidence with { EffectiveLocalPolicyVerified = false },
            "prior-state" => Evidence with { DurablePriorStateVerified = false },
            "recovery" => Evidence with { IndependentRecoveryVerified = false },
            "post-verification" => Evidence with { PostVerificationReady = false },
            "stale" => Evidence with { ObservedUtc = Now.AddMinutes(-6) },
            "future" => Evidence with { ObservedUtc = Now.AddSeconds(1) },
            "failures" => Evidence with { ConsecutiveFailures = 2 },
            _ => Evidence with { LastAttemptUtc = Now.AddMinutes(-1) }
        };
        var result = FirewallRepairPreview.Assess(ApprovedPolicy, evidence, true, Now);
        Assert.False(result.CanExecute);
        Assert.Contains(blocker, result.Blockers);
    }

    [Fact]
    public void Repeated_ping_failures_and_even_complete_design_evidence_never_enable_effects()
    {
        var onlyPings = FirewallRepairPreview.Assess(ApprovedPolicy,
            new() { ConsecutiveFailures = 999 }, true, Now);
        Assert.Contains("exact-rule-drift-unverified", onlyPings.Blockers);
        Assert.Contains("effective-policy-unverified-or-managed", onlyPings.Blockers);
        var complete = FirewallRepairPreview.Assess(ApprovedPolicy, Evidence, true, Now);
        Assert.Equal(new[] { "implementation-not-released" }, complete.Blockers);
        Assert.False(complete.CanExecute);
        var manual = FirewallRepairPreview.Assess(ApprovedPolicy,
            Evidence with { OperatorApprovalVerified = false }, false, Now);
        Assert.Contains("operator-approval-missing", manual.Blockers);
        Assert.False(manual.CanExecute);
    }

    [Fact]
    public void Default_site_policy_has_manual_and_automatic_repair_off()
    {
        var policy = new FirewallRepairPolicyDraft();
        Assert.False(policy.ManualRepairEnabled);
        Assert.False(policy.AutomaticRepairEnabled);
        var preview = FirewallRepairPreview.Assess(policy, new(), automatic: true, DateTimeOffset.UtcNow);
        Assert.False(preview.CanExecute);
        Assert.Contains("automatic-disabled", preview.Blockers);
        Assert.Contains("implementation-not-released", preview.Blockers);
    }
}

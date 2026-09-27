using System.Net;
using System.Net.Sockets;

namespace CabinetPlatform.Server.Actions;

/// <summary>
/// Proposed enable-only local inbound rule. No ranges, public profile, global toggle or default-policy edits.
/// Name is merely a proposed owned name; unique native rule identity must still be established independently.
/// </summary>
public sealed record FirewallRuleScopeDraft(string Name, string LocalAddress, string RemoteAddress,
    int LocalPort, int Protocol, int Profile)
{
    public bool IsNarrow => Name is { Length: > 15 and <= 80 } &&
        Name.StartsWith("CabinetSupport.", StringComparison.Ordinal) &&
        Name.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_') &&
        IsPrivateHost(LocalAddress) && IsPrivateHost(RemoteAddress) && LocalAddress != RemoteAddress &&
        LocalPort is >= 1 and <= 65535 && Protocol is 6 or 17 && Profile is 1 or 2;

    private static bool IsPrivateHost(string value)
    {
        if (!IPAddress.TryParse(value, out var address) || address.AddressFamily != AddressFamily.InterNetwork ||
            address.ToString() != value) return false;
        var b = address.GetAddressBytes();
        return b[3] is > 0 and < 255 && (b[0] == 10 || b[0] == 172 && b[1] is >= 16 and <= 31 || b[0] == 192 && b[1] == 168);
    }
}

/// <summary>
/// Design-only per-site policy draft. No persistence, endpoint, scheduler or executor consumes it.
/// Do not treat caller-supplied attestations as authorization when implementing the future workflow.
/// </summary>
public sealed record FirewallRepairPolicyDraft
{
    public Guid SiteId { get; init; }
    public Guid CabinetId { get; init; }
    public string Revision { get; init; } = string.Empty;
    public string ApprovalReference { get; init; } = string.Empty;
    public DateTimeOffset ValidUntilUtc { get; init; }
    public FirewallRuleScopeDraft? Scope { get; init; }
    public bool ManualRepairEnabled { get; init; }
    public bool AutomaticRepairEnabled { get; init; }
    public int ConsecutiveFailuresRequired { get; init; } = 3;
    public TimeSpan Cooldown { get; init; } = TimeSpan.FromMinutes(30);
}

/// <summary>
/// Design-only evidence requirements. A future implementation must obtain each from trusted server/local
/// services, binding it to the exact approved scope and revision. Never deserialize these as grants.
/// </summary>
public sealed record FirewallRepairEvidence
{
    public Guid SiteId { get; init; }
    public Guid CabinetId { get; init; }
    public string PolicyRevision { get; init; } = string.Empty;
    public DateTimeOffset ObservedUtc { get; init; }
    public bool SiteAuthorizationVerified { get; init; }
    public bool RegisteredSiteAddressesVerified { get; init; }
    public bool OperatorApprovalVerified { get; init; }
    public bool PreapprovalVerified { get; init; }
    public bool ExactOwnedRuleDriftVerified { get; init; }
    public bool EffectiveLocalPolicyVerified { get; init; }
    public bool DurablePriorStateVerified { get; init; }
    public bool IndependentRecoveryVerified { get; init; }
    public bool PostVerificationReady { get; init; }
    public int ConsecutiveFailures { get; init; }
    public DateTimeOffset? LastAttemptUtc { get; init; }
}

/// <summary>Non-executable review result. This type can never authorize native effects.</summary>
public sealed record FirewallRepairPreview(IReadOnlyList<string> Blockers)
{
    public bool CanExecute => false;

    public static FirewallRepairPreview Assess(FirewallRepairPolicyDraft policy,
        FirewallRepairEvidence evidence, bool automatic, DateTimeOffset nowUtc)
    {
        var blockers = new List<string> { "implementation-not-released" };
        if (automatic && !policy.AutomaticRepairEnabled) blockers.Add("automatic-disabled");
        if (!automatic && !policy.ManualRepairEnabled) blockers.Add("manual-disabled");
        if (policy.SiteId == Guid.Empty || policy.CabinetId == Guid.Empty ||
            policy.SiteId != evidence.SiteId || policy.CabinetId != evidence.CabinetId)
            blockers.Add("site-or-cabinet-mismatch");
        if (string.IsNullOrWhiteSpace(policy.Revision) || policy.Revision != evidence.PolicyRevision)
            blockers.Add("policy-revision-mismatch");
        if (policy.ValidUntilUtc <= nowUtc || string.IsNullOrWhiteSpace(policy.ApprovalReference))
            blockers.Add("policy-expired-or-unapproved");
        if (policy.Scope?.IsNarrow != true) blockers.Add("rule-scope-not-narrow");
        if (!evidence.SiteAuthorizationVerified) blockers.Add("site-authorization-missing");
        if (!evidence.RegisteredSiteAddressesVerified) blockers.Add("site-addresses-unverified");
        if (!automatic && !evidence.OperatorApprovalVerified) blockers.Add("operator-approval-missing");
        if (automatic && !evidence.PreapprovalVerified) blockers.Add("automatic-preapproval-missing");
        if (!evidence.ExactOwnedRuleDriftVerified) blockers.Add("exact-rule-drift-unverified");
        if (!evidence.EffectiveLocalPolicyVerified) blockers.Add("effective-policy-unverified-or-managed");
        if (!evidence.DurablePriorStateVerified) blockers.Add("durable-prior-state-missing");
        if (!evidence.IndependentRecoveryVerified) blockers.Add("independent-recovery-missing");
        if (!evidence.PostVerificationReady) blockers.Add("post-verification-missing");
        if (evidence.ObservedUtc > nowUtc || nowUtc - evidence.ObservedUtc > TimeSpan.FromMinutes(5))
            blockers.Add("inspection-stale-or-future");
        if (automatic)
        {
            if (policy.ConsecutiveFailuresRequired is < 3 or > 100 ||
                evidence.ConsecutiveFailures < policy.ConsecutiveFailuresRequired) blockers.Add("failure-threshold-not-met");
            if (policy.Cooldown < TimeSpan.FromMinutes(5) || policy.Cooldown > TimeSpan.FromDays(1) ||
                evidence.LastAttemptUtc is { } last && nowUtc - last < policy.Cooldown) blockers.Add("cooldown-active");
        }
        return new(blockers);
    }
}

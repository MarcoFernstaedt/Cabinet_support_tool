namespace CabinetPlatform.Server.Controllers;

/// <summary>An operator's non-activating commitment to a future, separately gated issuance.</summary>
public sealed record SuccessorIssuanceIntentRequest(Guid RequestId, string ProposedKeyHash);

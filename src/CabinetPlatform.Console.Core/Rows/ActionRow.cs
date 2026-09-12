using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>
/// One action request as the Approvals queue shows it.
/// </summary>
/// <remarks>
/// The requester's own pending requests appear here alongside everyone else's,
/// dimmed and labelled, rather than being filtered out. The four-eyes rule is
/// the single most surprising behaviour in this product for a new starter, and
/// a queue that silently omits your own request teaches you that the system
/// lost it. A queue that shows it greyed out with "you requested this" teaches
/// you the rule.
/// </remarks>
public sealed class ActionRow
{
    public ActionRow(ActionRequestView request, Guid? currentUserId, DateTimeOffset nowUtc)
    {
        Request = request;
        Status = StatusPresentation.ForAction(request.Status);
        Result = request.ResultStatus is { } result
            ? StatusPresentation.ForActionResult(result)
            : null;

        IsOwnRequest = currentUserId is { } id && id == request.RequestedByUserId;
        Expiry = DescribeExpiry(request.ExpiresUtc, nowUtc);
    }

    public ActionRequestView Request { get; }

    public Guid Id => Request.Id;
    public ActionName Action => Request.Action;
    public string ActionName => Request.Action.ToString();
    public string Hostname => Format.Text(Request.CabinetHostname);
    public string Client => Format.Text(Request.ClientName);
    public string Site => Format.Text(Request.SiteName);
    public string RequestedBy => Format.Text(Request.RequestedByDisplayName);
    public string RequestedAt => Format.LocalTime(Request.RequestedUtc);
    public string Reason => Format.Text(Request.Reason);
    public string Ticket => Format.Text(Request.TicketReference);
    public string Expiry { get; }

    public StatusPresentation Status { get; }
    public StatusPresentation? Result { get; }

    public string ResultOutput => Format.Text(Request.ResultOutput);

    public string Parameters => Request.Parameters.Count == 0
        ? "None"
        : string.Join(", ", Request.Parameters.Select(p => $"{p.Key}: {p.Value}"));

    /// <summary>True when the signed-in user is the one who asked for this.</summary>
    public bool IsOwnRequest { get; }

    /// <summary>
    /// Whether the Approve and Deny buttons are offered. The server refuses
    /// self-approval outright; disabling the button here only saves the user a
    /// round trip and an error message.
    /// </summary>
    public bool CanDecide => !IsOwnRequest && Request.Status == ActionRequestStatus.PendingApproval;

    /// <summary>
    /// Why the buttons are unavailable, shown beside the row. An unexplained
    /// disabled control is a support ticket waiting to be raised.
    /// </summary>
    public string? UnavailableReason => IsOwnRequest
        ? "You requested this action. A second person must approve it — you cannot approve your own request."
        : Request.Status != ActionRequestStatus.PendingApproval
            ? $"This request is {Status.Label.ToLowerInvariant()} and is no longer awaiting a decision."
            : null;

    public bool SafetyOverridden => Request.SafetyChecksOverridden;

    public string? OverrideNote => Request.SafetyChecksOverridden
        ? $"Safety checks overridden. {Format.Text(Request.OverrideReason)}"
        : null;

    public string AccessibleSummary
    {
        get
        {
            string core =
                $"{ActionName} on {Hostname}, {Client} {Site}. " +
                $"Requested by {RequestedBy} at {RequestedAt}. Reason: {Reason}. " +
                $"Ticket {Ticket}. {Status.Label}. {Expiry}.";

            return UnavailableReason is { } reason ? $"{core} {reason}" : core;
        }
    }

    private static string DescribeExpiry(DateTimeOffset? expiresUtc, DateTimeOffset nowUtc)
    {
        if (expiresUtc is null)
        {
            return "No expiry set";
        }

        TimeSpan remaining = expiresUtc.Value - nowUtc;

        if (remaining <= TimeSpan.Zero)
        {
            return "Expired";
        }

        return remaining.TotalMinutes < 60
            ? $"Expires in {Math.Max(1, (int)remaining.TotalMinutes)} minutes"
            : $"Expires {Format.LocalTime(expiresUtc)}";
    }
}

using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// What a cabinet currently has scheduled to install, and when.
/// </summary>
/// <remarks>
/// Returned by <see cref="Actions.ActionName.GetScheduledUpdates"/>. The instant
/// travels as UTC and the cabinet's own local rendering travels beside it,
/// because "02:00" means nothing to a rep in another country and a UTC instant
/// means nothing to the clinic that agreed the window.
/// </remarks>
public sealed record ScheduledUpdateInstallDto
{
    /// <summary>Whether anything is scheduled at all.</summary>
    public required bool HasSchedule { get; init; }

    /// <summary>When the install is due, in UTC.</summary>
    public DateTimeOffset? ScheduledForUtc { get; init; }

    /// <summary>
    /// The same instant as the cabinet's own clock will read it.
    /// </summary>
    /// <remarks>
    /// Re-derived by the agent from the stored UTC instant at the moment it is
    /// asked, not carried forward from when the schedule was written. That is
    /// what makes the answer correct across a daylight-saving transition
    /// between scheduling and execution: the wall-clock time a cabinet will
    /// actually install at can differ by an hour from the one that was written
    /// down, and the honest answer is the one derived now.
    /// </remarks>
    public DateTimeOffset? ScheduledForCabinetLocal { get; init; }

    /// <summary>The updates the schedule names.</summary>
    public IReadOnlyList<string> UpdateIds { get; init; } = Array.Empty<string>();

    /// <summary>Whether the install may restart the cabinet when it needs to.</summary>
    public required bool RebootIfRequired { get; init; }

    /// <summary>Who asked for it, so a rep can see whose window they are about to move.</summary>
    public Guid? RequestedByUserId { get; init; }

    /// <summary>The action request the schedule came from.</summary>
    public Guid? ActionRequestId { get; init; }
}

/// <summary>
/// What a cabinet actually did with a scheduled or immediate install.
/// </summary>
/// <remarks>
/// <para>
/// Reported on the next check-in after the install ran, not at the moment the
/// schedule was written. Those are different facts and conflating them is how a
/// fleet comes to believe it is patched: scheduling an update is an intent, and
/// the machine may reboot into a rollback, run out of disk, or find the package
/// superseded.
/// </para>
/// <para>
/// The server writes a <see cref="Audit.AuditEventKind.Caused"/> audit entry
/// when it receives one of these, because the platform caused the install even
/// though Windows performed it.
/// </para>
/// </remarks>
public sealed record UpdateInstallOutcome
{
    /// <summary>The action request this outcome answers.</summary>
    public required Guid ActionRequestId { get; init; }

    /// <summary>UTC instant the install finished.</summary>
    public required DateTimeOffset CompletedUtc { get; init; }

    /// <summary>What each named update did.</summary>
    public IReadOnlyList<UpdateInstallResult> Results { get; init; } = Array.Empty<UpdateInstallResult>();

    /// <summary>Whether the cabinet still needs a restart to finish.</summary>
    public bool? RebootRequired { get; init; }
}

/// <summary>One update's install outcome.</summary>
public sealed record UpdateInstallResult
{
    /// <summary>Windows Update identifier for the update.</summary>
    public required string UpdateId { get; init; }

    /// <summary>Its title, for a person reading the outcome.</summary>
    public string? Title { get; init; }

    /// <summary>What Windows recorded.</summary>
    public required UpdateResultCode ResultCode { get; init; }

    /// <summary>Windows error code, when the install failed.</summary>
    public int? ErrorCode { get; init; }
}

/// <summary>What a process-management action did.</summary>
/// <remarks>
/// Carries the process identity as the agent saw it at the moment it acted,
/// which is the evidence a reviewer needs: a kill by id is only defensible
/// alongside proof that the id still named what the requester thought it did.
/// </remarks>
public sealed record ProcessActionResultDto
{
    /// <summary>Image name the action operated on.</summary>
    public required string ProcessName { get; init; }

    /// <summary>Process ids the action ended.</summary>
    public IReadOnlyList<int> EndedProcessIds { get; init; } = Array.Empty<int>();

    /// <summary>Process ids the agent refused to end, with the reason for each.</summary>
    public IReadOnlyList<ProcessActionRefusal> Refused { get; init; } = Array.Empty<ProcessActionRefusal>();

    /// <summary>
    /// Process id of the relaunched application, for a restart. Null for a
    /// plain kill, and null when the relaunch itself failed.
    /// </summary>
    public int? RelaunchedProcessId { get; init; }
}

/// <summary>One process the agent declined to act on, and why.</summary>
public sealed record ProcessActionRefusal
{
    /// <summary>The process id.</summary>
    public required int ProcessId { get; init; }

    /// <summary>The image name the agent actually found for it.</summary>
    public string? ObservedName { get; init; }

    /// <summary>Why the agent left it alone.</summary>
    public required string Reason { get; init; }
}

/// <summary>
/// What a network configuration change did, including whether it had to be
/// rolled back.
/// </summary>
/// <remarks>
/// The reverted case is the one this record exists for. A cabinet that applies
/// a wrong DNS server and reverts it has had an outage of a few seconds and
/// remains reachable; without the revert it is a site visit. The result says
/// plainly which happened, because "succeeded" for an applied-then-reverted
/// change would be a lie a rep would act on.
/// </remarks>
public sealed record NetworkChangeResultDto
{
    /// <summary>The adapter that was changed.</summary>
    public required string AdapterId { get; init; }

    /// <summary>Its friendly name, for a person reading the outcome.</summary>
    public string? AdapterName { get; init; }

    /// <summary>How the change ended.</summary>
    public required NetworkChangeOutcome Outcome { get; init; }

    /// <summary>The configuration as it was before the change, in case it must be read back.</summary>
    public string? PreviousConfiguration { get; init; }

    /// <summary>The configuration that was applied.</summary>
    public string? AppliedConfiguration { get; init; }

    /// <summary>How long the agent waited for the server before deciding, in seconds.</summary>
    public required int ConfirmationTimeoutSeconds { get; init; }
}

/// <summary>How a confirm-or-revert network change ended.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum NetworkChangeOutcome
{
    /// <summary>The outcome could not be established.</summary>
    Unknown = 0,

    /// <summary>Applied, and the cabinet reached the server afterwards. The change stands.</summary>
    Confirmed = 1,

    /// <summary>
    /// Applied, the cabinet could not reach the server, and the previous
    /// configuration was put back. The cabinet is as it was.
    /// </summary>
    Reverted = 2,

    /// <summary>
    /// Applied, the cabinet could not reach the server, and the revert also
    /// failed. This is the state that needs a person, and it is reported as
    /// itself rather than folded into a failure.
    /// </summary>
    RevertFailed = 3,

    /// <summary>The change was not applied at all.</summary>
    NotApplied = 4,
}

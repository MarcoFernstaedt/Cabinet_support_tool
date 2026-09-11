using CabinetPlatform.Contracts.Enums;

namespace CabinetPlatform.Console.Core.Presentation;

/// <summary>
/// How one status is rendered: a word, a distinct shape, and a severity the
/// theme may colour.
/// </summary>
/// <remarks>
/// <para>
/// Nothing in this console conveys status by colour alone. Every status carries
/// <see cref="Label"/> and <see cref="Glyph"/>, and the colour a view derives
/// from <see cref="Severity"/> is the third, redundant channel — never the only
/// one. A red dot and a green dot are the same dot to a colour-blind user, to a
/// screen reader, and to anyone printing a screenshot into a ticket.
/// </para>
/// <para>
/// <see cref="Glyph"/> characters are chosen to differ in outline and not only
/// in fill, so they survive being rendered at 100% in a high-contrast theme
/// where every foreground is the same colour.
/// </para>
/// </remarks>
public sealed record StatusPresentation(string Label, string Glyph, StatusSeverity Severity)
{
    /// <summary>
    /// What a screen reader reads and what the tooltip shows. The glyph is
    /// deliberately absent: "check mark Healthy" is noise, "Healthy" is the
    /// information.
    /// </summary>
    public string AccessibleText => Label;

    public override string ToString() => $"{Glyph} {Label}";

    // --- Cabinet health ---------------------------------------------------

    public static StatusPresentation ForCabinet(CabinetHealthStatus status) => status switch
    {
        CabinetHealthStatus.Healthy => new("Healthy", "✔", StatusSeverity.Good),
        CabinetHealthStatus.Warning => new("Warning", "▲", StatusSeverity.Warning),
        CabinetHealthStatus.Critical => new("Critical", "✖", StatusSeverity.Critical),
        CabinetHealthStatus.Offline => new("Offline", "●", StatusSeverity.Critical),
        _ => Unknown
    };

    // --- Disk health ------------------------------------------------------

    public static StatusPresentation ForDisk(DiskHealthStatus status) => status switch
    {
        DiskHealthStatus.Healthy => new("Healthy", "✔", StatusSeverity.Good),
        DiskHealthStatus.Warning => new("Watch", "▲", StatusSeverity.Warning),
        DiskHealthStatus.Critical => new("Failing", "✖", StatusSeverity.Critical),
        DiskHealthStatus.Failed => new("Failed", "✖", StatusSeverity.Critical),
        _ => Unknown
    };

    /// <summary>
    /// A drive that did not report a verdict. Distinct from healthy, and said so
    /// in words: a drive whose SMART data could not be read is not a drive with
    /// nothing wrong with it.
    /// </summary>
    public static StatusPresentation Unknown { get; } = new("Not reported", "?", StatusSeverity.Unknown);

    // --- Action lifecycle -------------------------------------------------

    public static StatusPresentation ForAction(ActionRequestStatus status) => status switch
    {
        ActionRequestStatus.PendingApproval => new("Awaiting approval", "⏸", StatusSeverity.Warning),
        ActionRequestStatus.Approved => new("Approved", "✔", StatusSeverity.Good),
        ActionRequestStatus.Denied => new("Denied", "✖", StatusSeverity.Critical),
        ActionRequestStatus.Dispatched => new("Sent to cabinet", "▶", StatusSeverity.Neutral),
        ActionRequestStatus.Completed => new("Completed", "✔", StatusSeverity.Good),
        ActionRequestStatus.Expired => new("Expired", "○", StatusSeverity.Warning),
        ActionRequestStatus.Cancelled => new("Cancelled", "○", StatusSeverity.Neutral),
        _ => Unknown
    };

    public static StatusPresentation ForActionResult(ActionResultStatus status) => status switch
    {
        ActionResultStatus.Succeeded => new("Succeeded", "✔", StatusSeverity.Good),
        ActionResultStatus.Failed => new("Failed", "✖", StatusSeverity.Critical),
        ActionResultStatus.TimedOut => new("Timed out", "○", StatusSeverity.Warning),
        ActionResultStatus.Refused => new("Refused by agent", "✖", StatusSeverity.Critical),
        _ => Unknown
    };

    // --- Audit ------------------------------------------------------------

    public static StatusPresentation ForAuditResult(AuditResult result) => result switch
    {
        AuditResult.Success => new("Success", "✔", StatusSeverity.Good),
        AuditResult.Denied => new("Denied", "✖", StatusSeverity.Warning),
        AuditResult.Failure => new("Failure", "✖", StatusSeverity.Critical),
        _ => Unknown
    };

    /// <summary>
    /// Observed against Caused. Worth distinct shapes as well as distinct words:
    /// this is the distinction a compliance reviewer scans the audit grid for,
    /// and it is the one that must never be guessable only from a colour.
    /// </summary>
    public static StatusPresentation ForAuditKind(AuditEventKind kind) => kind switch
    {
        AuditEventKind.Observed => new("Observed", "○", StatusSeverity.Neutral),
        AuditEventKind.Caused => new("Caused", "◆", StatusSeverity.Warning),
        _ => Unknown
    };

    // --- Windows service state -------------------------------------------

    /// <summary>
    /// Built from the agent's own strings rather than an enum, because
    /// <see cref="Contracts.Agent.ServiceSnapshot.Status"/> is free text from
    /// the machine. An unrecognised value is shown as itself: inventing a
    /// category for it would be a guess displayed as a fact.
    /// </summary>
    public static StatusPresentation ForServiceState(string? status)
    {
        if (string.IsNullOrWhiteSpace(status))
        {
            return new("Not reported", "?", StatusSeverity.Unknown);
        }

        return status.Trim().ToLowerInvariant() switch
        {
            "running" => new("Running", "✔", StatusSeverity.Good),
            "stopped" => new("Stopped", "■", StatusSeverity.Warning),
            "paused" => new("Paused", "⏸", StatusSeverity.Warning),
            "startpending" or "start pending" => new("Starting", "▶", StatusSeverity.Neutral),
            "stoppending" or "stop pending" => new("Stopping", "▶", StatusSeverity.Neutral),
            _ => new(status.Trim(), "?", StatusSeverity.Unknown)
        };
    }

    public static StatusPresentation ForBoolean(bool? value, string whenTrue, string whenFalse) => value switch
    {
        true => new(whenTrue, "✔", StatusSeverity.Neutral),
        false => new(whenFalse, "✖", StatusSeverity.Neutral),
        null => new("Not reported", "?", StatusSeverity.Unknown)
    };
}

/// <summary>
/// Severity a view may map to a colour — always alongside the label and glyph,
/// never instead of them.
/// </summary>
public enum StatusSeverity
{
    /// <summary>Informational; carries no judgement.</summary>
    Neutral,
    Good,
    Warning,
    Critical,

    /// <summary>
    /// Not reported. Kept apart from <see cref="Neutral"/> so a view cannot
    /// render "no data" the same way it renders "nothing wrong".
    /// </summary>
    Unknown
}

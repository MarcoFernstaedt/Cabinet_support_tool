using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

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
        DiskHealthStatus.Watch => new("Watch", "▲", StatusSeverity.Warning),
        DiskHealthStatus.Failing => new("Failing", "✖", StatusSeverity.Critical),
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

    public static StatusPresentation ForActionResult(ActionStatus status) => status switch
    {
        ActionStatus.Succeeded => new("Succeeded", "✔", StatusSeverity.Good),
        ActionStatus.Failed => new("Failed", "✖", StatusSeverity.Critical),
        ActionStatus.TimedOut => new("Timed out", "○", StatusSeverity.Warning),
        ActionStatus.Denied => new("Refused by agent", "✖", StatusSeverity.Critical),

        // Distinct from a failure on purpose. The agent restarted while this
        // was running and genuinely cannot say whether it took effect; nothing
        // retries it, and a person establishes what actually happened.
        ActionStatus.UnknownResult => new("Outcome unknown", "?", StatusSeverity.Warning),
        _ => Unknown,
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
    /// How a service's run state reads at a glance.
    /// </summary>
    /// <remarks>
    /// <see cref="ServiceState.Unknown"/> is shown as "not reported", never as
    /// stopped. A state the agent could not read is not a service that is down,
    /// and presenting it as one sends a rep looking for a fault that is not
    /// there.
    /// </remarks>
    /// <param name="state">The state the agent reported.</param>
    public static StatusPresentation ForServiceState(ServiceState state) => state switch
    {
        ServiceState.Running => new("Running", "✔", StatusSeverity.Good),
        ServiceState.Stopped => new("Stopped", "■", StatusSeverity.Warning),
        ServiceState.Paused => new("Paused", "⏸", StatusSeverity.Warning),
        ServiceState.StartPending => new("Starting", "▶", StatusSeverity.Neutral),
        ServiceState.StopPending => new("Stopping", "▶", StatusSeverity.Neutral),
        ServiceState.ContinuePending => new("Resuming", "▶", StatusSeverity.Neutral),
        ServiceState.PausePending => new("Pausing", "▶", StatusSeverity.Neutral),
        _ => new("Not reported", "?", StatusSeverity.Unknown),
    };

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

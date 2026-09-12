using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Audit;

namespace CabinetPlatform.Console.Core.Rows;

/// <summary>One audit entry, formatted for a grid a reviewer will read down.</summary>
public sealed class AuditRow
{
    public AuditRow(AuditEntryDto entry)
    {
        Entry = entry;
        Kind = StatusPresentation.ForAuditKind(entry.EventKind);
        Result = StatusPresentation.ForAuditResult(entry.Result);
    }

    public AuditEntryDto Entry { get; }

    public Guid Id => Entry.Id;
    /// <summary>When the record was written, for ordering.</summary>
    public DateTimeOffset TimestampUtc => Entry.TimestampUtc;
    public string Timestamp => Format.LocalTime(Entry.TimestampUtc);
    /// <summary>What kind of actor the record is attributed to.</summary>
    public string ActorType => Entry.ActorType.ToString();
    public string Actor => Format.Text(Entry.ActorDisplayName ?? Entry.ActorId);
    /// <summary>
    /// Which audit event this is.
    /// </summary>
    public string Event => Entry.Event.ToString();

    /// <summary>
    /// The catalog action the record concerns, or "not applicable" for the
    /// many records — a sign-in, a read, a registration decision — that concern
    /// none. Rendering those as an empty action would suggest one was involved.
    /// </summary>
    public string Action => Entry.Action?.ToString() ?? "Not applicable";
    public string Hostname => Format.Text(Entry.CabinetHostname);
    public string Reason => Format.Text(Entry.Reason);
    public string Ticket => Format.Text(Entry.TicketReference);
    public string Details => Format.Text(Entry.Details);
    public string CorrelationId => Format.Text(Entry.CorrelationId);

    public StatusPresentation Kind { get; }
    public StatusPresentation Result { get; }

    public string AccessibleSummary =>
        $"{Timestamp}. {Kind.Label}. {Action} by {Actor} ({ActorType}). " +
        $"{(Hostname == Format.NotReported ? "No cabinet" : $"Cabinet {Hostname}")}. " +
        $"Result {Result.Label}. Reason: {Reason}. Ticket {Ticket}.";
}

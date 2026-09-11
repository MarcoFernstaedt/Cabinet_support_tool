using Mashura.CabinetSupport.Console.Core.Presentation;
using Mashura.CabinetSupport.Contracts.Audit;

namespace Mashura.CabinetSupport.Console.Core.Rows;

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
    public DateTime TimestampUtc => Entry.TimestampUtc;
    public string Timestamp => Format.LocalTime(Entry.TimestampUtc);
    public string ActorType => Format.Text(Entry.ActorType);
    public string Actor => Format.Text(Entry.ActorDisplayName ?? Entry.ActorId);
    public string Action => Format.Text(Entry.Action);
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

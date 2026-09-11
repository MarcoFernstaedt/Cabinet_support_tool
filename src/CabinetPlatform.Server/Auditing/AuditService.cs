using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;

namespace CabinetPlatform.Server.Auditing;

/// <summary>Everything one audit record needs, assembled by the caller.</summary>
public sealed class AuditRecord
{
    /// <summary>Which audit event this is, drawn from the fixed catalog.</summary>
    public required AuditEvent Event { get; init; }

    /// <summary>Whether the platform observed this or caused it.</summary>
    public required AuditEventKind EventKind { get; init; }

    /// <summary>Outcome, including refusals.</summary>
    public required AuditResult Result { get; init; }

    /// <summary>The catalog action this record concerns, when it concerns one.</summary>
    public ActionName? Action { get; init; }

    /// <summary>What kind of actor is responsible.</summary>
    public ActorType ActorType { get; init; } = ActorType.System;

    /// <summary>User id, cabinet machine id, or null when unidentified.</summary>
    public string? ActorId { get; init; }

    /// <summary>The actor's display name, when one is known.</summary>
    public string? ActorDisplayName { get; init; }

    /// <summary>Cabinet the record concerns.</summary>
    public Guid? CabinetId { get; init; }

    /// <summary>That cabinet's hostname at the time.</summary>
    public string? CabinetHostname { get; init; }

    /// <summary>Cabinet a diagnostic probe targeted.</summary>
    public Guid? TargetCabinetId { get; init; }

    /// <summary>That target cabinet's hostname at the time.</summary>
    public string? TargetCabinetHostname { get; init; }

    /// <summary>Justification given, or the reason for a refusal.</summary>
    public string? Reason { get; init; }

    /// <summary>Support ticket the record is associated with.</summary>
    public string? TicketReference { get; init; }

    /// <summary>The second person who approved, on approval events.</summary>
    public Guid? ApprovedByUserId { get; init; }

    /// <summary>Batch this record belongs to, when it was part of one.</summary>
    public Guid? BatchId { get; init; }

    /// <summary>
    /// Structured context, serialised to JSON. Must never carry a password, a
    /// password hash, a token or a connection string — callers pass identifiers
    /// and decisions, not credentials.
    /// </summary>
    public object? Details { get; init; }
}

/// <summary>
/// The single way anything in this server writes to the audit trail.
/// </summary>
/// <remarks>
/// There is deliberately no update and no delete: the interface offers one
/// verb, and the DbContext refuses a modified or deleted audit row even if
/// someone later reaches around this service to the DbSet.
/// </remarks>
public interface IAuditService
{
    /// <summary>Writes and saves one record immediately.</summary>
    /// <param name="record">The record to write.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    Task WriteAsync(AuditRecord record, CancellationToken cancellationToken = default);

    /// <summary>
    /// Stages a record into the current unit of work so the change and its
    /// audit row commit or roll back together. The caller saves.
    /// </summary>
    /// <param name="record">The record to stage.</param>
    void Enqueue(AuditRecord record);

    /// <summary>Convenience for the commonest case: a caller was refused.</summary>
    /// <param name="auditEvent">Which audit event was refused.</param>
    /// <param name="reason">Why it was refused.</param>
    /// <param name="cabinetId">Cabinet the refusal concerns, if any.</param>
    /// <param name="details">Structured context.</param>
    /// <param name="action">The catalog action refused, if any.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    Task WriteDenialAsync(
        AuditEvent auditEvent,
        string reason,
        Guid? cabinetId = null,
        object? details = null,
        ActionName? action = null,
        CancellationToken cancellationToken = default);
}

/// <inheritdoc />
public sealed class AuditService : IAuditService
{
    // Same convention as the wire format: enum names, not numbers. An audit
    // record read in a compliance review should not need a lookup table.
    private static readonly JsonSerializerOptions DetailsJsonOptions = ContractJson.CreateOptions();

    private readonly SupportDbContext _db;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly ILogger<AuditService> _logger;
    private readonly TimeProvider _timeProvider;

    /// <summary>Creates the service.</summary>
    /// <param name="db">The database.</param>
    /// <param name="httpContextAccessor">Supplies correlation id and caller address.</param>
    /// <param name="logger">Diagnostic log.</param>
    /// <param name="timeProvider">Clock.</param>
    public AuditService(
        SupportDbContext db,
        IHttpContextAccessor httpContextAccessor,
        ILogger<AuditService> logger,
        TimeProvider timeProvider)
    {
        _db = db;
        _httpContextAccessor = httpContextAccessor;
        _logger = logger;
        _timeProvider = timeProvider;
    }

    /// <inheritdoc />
    public void Enqueue(AuditRecord record) => _db.AuditEntries.Add(Build(record));

    /// <inheritdoc />
    public async Task WriteAsync(AuditRecord record, CancellationToken cancellationToken = default)
    {
        _db.AuditEntries.Add(Build(record));
        await _db.SaveChangesAsync(cancellationToken);
    }

    /// <inheritdoc />
    public Task WriteDenialAsync(
        AuditEvent auditEvent,
        string reason,
        Guid? cabinetId = null,
        object? details = null,
        ActionName? action = null,
        CancellationToken cancellationToken = default)
    {
        HttpContext? http = _httpContextAccessor.HttpContext;
        CurrentUser? user = http?.User.GetCurrentUser();
        string? machineId = http?.User.GetAgentMachineId();

        (ActorType actorType, string? actorId, string? actorName) = user is not null
            ? (ActorType.User, user.UserId.ToString(), user.Username)
            : machineId is not null
                ? (ActorType.Agent, machineId, (string?)null)
                : (ActorType.Anonymous, null, (string?)null);

        return WriteAsync(
            new AuditRecord
            {
                Event = auditEvent,
                Action = action,
                // A refused attempt changed nothing on a cabinet, so it is
                // Observed. The Denied result is what marks it as an attempt.
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Denied,
                ActorType = actorType,
                ActorId = actorId,
                ActorDisplayName = actorName,
                CabinetId = cabinetId,
                Reason = reason,
                Details = details,
            },
            cancellationToken);
    }

    private AuditEntry Build(AuditRecord record)
    {
        HttpContext? http = _httpContextAccessor.HttpContext;

        var entry = new AuditEntry
        {
            TimestampUtc = _timeProvider.GetUtcNow(),
            ActorType = record.ActorType,
            ActorId = Truncate(record.ActorId, 128),
            ActorDisplayName = Truncate(record.ActorDisplayName, 128),
            EventKind = record.EventKind,
            Event = record.Event,
            Action = record.Action,
            CabinetId = record.CabinetId,
            CabinetHostname = Truncate(record.CabinetHostname, 255),
            TargetCabinetId = record.TargetCabinetId,
            TargetCabinetHostname = Truncate(record.TargetCabinetHostname, 255),
            Result = record.Result,
            Reason = Truncate(record.Reason, 2000),
            TicketReference = Truncate(record.TicketReference, 64),
            ApprovedByUserId = record.ApprovedByUserId,
            BatchId = record.BatchId,
            CorrelationId = http?.TraceIdentifier,
            RemoteIpAddress = http?.Connection.RemoteIpAddress?.ToString(),
        };

        if (record.Details is not null)
        {
            try
            {
                entry.Details = JsonSerializer.Serialize(record.Details, DetailsJsonOptions);
            }
            catch (NotSupportedException ex)
            {
                // Losing the whole record because its context would not
                // serialise would be worse than losing the context: the fact
                // that the event happened is the part that must survive.
                _logger.LogWarning(ex, "Audit details for {Event} could not be serialised.", record.Event);
                entry.Details = null;
            }
        }

        return entry;
    }

    private static string? Truncate(string? value, int maxLength) =>
        value is null || value.Length <= maxLength ? value : value[..maxLength];
}

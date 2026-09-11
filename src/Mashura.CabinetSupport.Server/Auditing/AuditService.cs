using System.Text.Json;
using Mashura.CabinetSupport.Contracts.Enums;
using Mashura.CabinetSupport.Server.Data;
using Mashura.CabinetSupport.Server.Domain;
using Mashura.CabinetSupport.Server.Security;

namespace Mashura.CabinetSupport.Server.Auditing;

/// <summary>Canonical action names. Strings drift; constants do not.</summary>
public static class AuditActions
{
    public const string Login = "auth.login";
    public const string Logout = "auth.logout";
    public const string ChangePassword = "auth.change_password";
    public const string ViewSelf = "auth.view_self";

    public const string AgentRegister = "agent.register";
    public const string AgentCheckIn = "agent.checkin";
    public const string AgentCollectActions = "agent.collect_actions";
    public const string AgentReportResult = "agent.report_result";

    public const string ListCabinets = "cabinet.list";
    public const string ViewCabinetLatest = "cabinet.view_latest";
    public const string ViewCabinetHistory = "cabinet.view_history";
    public const string ViewSmartHistory = "cabinet.view_smart_history";
    public const string ViewFleetHealth = "fleet.view_health";

    public const string ListPendingRegistrations = "registration.list_pending";
    public const string ApproveRegistration = "registration.approve";
    public const string RejectRegistration = "registration.reject";

    public const string ListUsers = "user.list";
    public const string CreateUser = "user.create";
    public const string UpdateUser = "user.update";
    public const string GrantElevatedSql = "user.grant_elevated_sql";
    public const string RevokeElevatedSql = "user.revoke_elevated_sql";

    public const string ViewActionCatalog = "action.view_catalog";
    public const string RequestAction = "action.request";
    public const string ListActions = "action.list";
    public const string ListPendingApproval = "action.list_pending_approval";
    public const string ApproveAction = "action.approve";
    public const string DenyAction = "action.deny";
    public const string ExpireAction = "action.expire";

    public const string ViewAudit = "audit.view";

    public const string RetentionSweep = "system.retention_sweep";
    public const string SeedSupervisor = "system.seed_supervisor";
    public const string AuthorizationDenied = "security.authorization_denied";
}

public static class ActorTypes
{
    public const string User = "User";
    public const string Agent = "Agent";
    public const string System = "System";
    public const string Anonymous = "Anonymous";
}

/// <summary>Everything one audit record needs, assembled by the caller.</summary>
public sealed class AuditRecord
{
    public required string Action { get; init; }
    public required AuditEventKind EventKind { get; init; }
    public required AuditResult Result { get; init; }

    public string ActorType { get; init; } = ActorTypes.System;
    public string? ActorId { get; init; }
    public string? ActorDisplayName { get; init; }
    public Guid? CabinetId { get; init; }
    public string? CabinetHostname { get; init; }
    public string? Reason { get; init; }
    public string? TicketReference { get; init; }
    public Guid? ApprovedByUserId { get; init; }

    /// <summary>
    /// Structured context, serialised to JSON. Must never carry a password, a
    /// password hash, a token or a connection string — callers pass identifiers
    /// and decisions, not credentials.
    /// </summary>
    public object? Details { get; init; }
}

/// <summary>
/// The single way anything in this server writes to the audit trail.
///
/// There is deliberately no update and no delete: the interface offers one
/// verb, and the DbContext refuses a modified or deleted audit row even if
/// someone later reaches around this service to the DbSet.
/// </summary>
public interface IAuditService
{
    /// <summary>Writes and saves one record immediately.</summary>
    Task WriteAsync(AuditRecord record, CancellationToken cancellationToken = default);

    /// <summary>
    /// Stages a record into the current unit of work so the change and its
    /// audit row commit or roll back together. The caller saves.
    /// </summary>
    void Enqueue(AuditRecord record);

    /// <summary>Convenience for the commonest case: a caller was refused.</summary>
    Task WriteDenialAsync(
        string action,
        string reason,
        Guid? cabinetId = null,
        object? details = null,
        CancellationToken cancellationToken = default);
}

public sealed class AuditService : IAuditService
{
    // Same convention as the wire format: enum names, not numbers. An audit
    // record read in a compliance review should not need a lookup table.
    private static readonly JsonSerializerOptions DetailsJsonOptions =
        Contracts.Common.ContractJson.CreateOptions();

    private readonly SupportDbContext _db;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly ILogger<AuditService> _logger;
    private readonly TimeProvider _timeProvider;

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

    public void Enqueue(AuditRecord record) => _db.AuditEntries.Add(Build(record));

    public async Task WriteAsync(AuditRecord record, CancellationToken cancellationToken = default)
    {
        _db.AuditEntries.Add(Build(record));
        await _db.SaveChangesAsync(cancellationToken);
    }

    public Task WriteDenialAsync(
        string action,
        string reason,
        Guid? cabinetId = null,
        object? details = null,
        CancellationToken cancellationToken = default)
    {
        HttpContext? http = _httpContextAccessor.HttpContext;
        CurrentUser? user = http?.User.GetCurrentUser();
        string? machineId = http?.User.GetAgentMachineId();

        (string actorType, string? actorId, string? actorName) = user is not null
            ? (ActorTypes.User, user.UserId.ToString(), user.Username)
            : machineId is not null
                ? (ActorTypes.Agent, machineId, (string?)null)
                : (ActorTypes.Anonymous, null, (string?)null);

        return WriteAsync(
            new AuditRecord
            {
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
                Details = details
            },
            cancellationToken);
    }

    private AuditEntry Build(AuditRecord record)
    {
        HttpContext? http = _httpContextAccessor.HttpContext;

        var entry = new AuditEntry
        {
            TimestampUtc = _timeProvider.GetUtcNow().UtcDateTime,
            ActorType = record.ActorType,
            ActorId = Truncate(record.ActorId, 128),
            ActorDisplayName = Truncate(record.ActorDisplayName, 128),
            EventKind = record.EventKind,
            Action = Truncate(record.Action, 128) ?? record.Action,
            CabinetId = record.CabinetId,
            CabinetHostname = Truncate(record.CabinetHostname, 255),
            Result = record.Result,
            Reason = Truncate(record.Reason, 2000),
            TicketReference = Truncate(record.TicketReference, 64),
            ApprovedByUserId = record.ApprovedByUserId,
            CorrelationId = http?.TraceIdentifier,
            RemoteIpAddress = http?.Connection.RemoteIpAddress?.ToString()
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
                _logger.LogWarning(ex, "Audit details for {Action} could not be serialised.", record.Action);
                entry.Details = null;
            }
        }

        return entry;
    }

    private static string? Truncate(string? value, int maxLength) =>
        value is null || value.Length <= maxLength ? value : value[..maxLength];
}

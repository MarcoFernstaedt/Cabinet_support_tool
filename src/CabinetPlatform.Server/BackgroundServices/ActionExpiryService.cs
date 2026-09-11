using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.BackgroundServices;

/// <summary>
/// Retires approved actions nobody collected.
///
/// The agent poll already filters on the expiry, so an expired action can
/// never be dispatched. This service exists so the expiry is also visible:
/// an approval that quietly sat in the queue until it was irrelevant should
/// show up as Expired in the console and in the trail, not as perpetually
/// pending.
/// </summary>
public sealed class ActionExpiryService : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ActionOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<ActionExpiryService> _logger;

    public ActionExpiryService(
        IServiceScopeFactory scopeFactory,
        IOptions<ActionOptions> options,
        TimeProvider timeProvider,
        ILogger<ActionExpiryService> logger)
    {
        _scopeFactory = scopeFactory;
        _options = options.Value;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(15, _options.ExpirySweepIntervalSeconds));

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Action expiry sweep failed; will retry at the next interval.");
            }

            try
            {
                await Task.Delay(interval, _timeProvider, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    internal async Task<int> SweepAsync(CancellationToken ct)
    {
        using IServiceScope scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
        var audit = scope.ServiceProvider.GetRequiredService<IAuditService>();

        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        // Only actions that were never handed to an agent. One that was
        // dispatched and is still awaiting its result is a different problem,
        // and marking it Expired would misrepresent what happened on the
        // cabinet.
        List<ActionRequest> stale = await db.ActionRequests
            .Include(a => a.Cabinet)
            .Where(a => a.DispatchedUtc == null &&
                        a.ExpiresUtc != null &&
                        a.ExpiresUtc < nowUtc &&
                        (a.Status == ActionRequestStatus.Approved ||
                         a.Status == ActionRequestStatus.PendingApproval))
            .Take(500)
            .ToListAsync(ct);

        if (stale.Count == 0)
        {
            return 0;
        }

        foreach (ActionRequest action in stale)
        {
            action.Status = ActionRequestStatus.Expired;
            action.CompletedUtc = nowUtc;

            audit.Enqueue(new AuditRecord
            {
                Event = AuditEvent.ExpireAction,
                Action = action.Action,
                // Nothing reached the cabinet, so nothing was caused out there.
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Success,
                ActorType = ActorType.System,
                ActorId = nameof(ActionExpiryService),
                ActorDisplayName = nameof(ActionExpiryService),
                CabinetId = action.CabinetId,
                CabinetHostname = action.Cabinet?.Hostname,
                TicketReference = action.TicketReference,
                Reason = "Approved action expired before any agent collected it.",
                Details = new
                {
                    ActionRequestId = action.Id,
                    Action = action.Action.ToString(),
                    action.RequestedByUserId,
                    action.ApprovedByUserId,
                    action.ExpiresUtc
                }
            });
        }

        await db.SaveChangesAsync(ct);

        _logger.LogInformation("Expired {Count} uncollected action requests.", stale.Count);

        return stale.Count;
    }
}

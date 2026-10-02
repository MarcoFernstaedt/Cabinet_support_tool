using System.Security.Cryptography;
using System.Text.Json;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

public sealed partial class ConnectivityController
{
    private sealed record HistoryCursor(int Version, Guid Source, Guid? Target, DateTimeOffset From,
        DateTimeOffset To, DateTimeOffset AsOf, DateTimeOffset LastObserved, Guid LastId);

    [HttpGet("cabinets/{sourceId:guid}/history")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<ActionResult<ConnectivityHistoryPage>> History(Guid sourceId, [FromQuery] Guid? targetId,
        [FromQuery(Name = "from")] DateTimeOffset? from, [FromQuery(Name = "to")] DateTimeOffset? to,
        [FromQuery] int pageSize = 20, [FromQuery] string? nextCursor = null, CancellationToken ct = default)
    {
        var now = time.GetUtcNow();
        if (sourceId == Guid.Empty || targetId == Guid.Empty || pageSize is < 1 or > 50 ||
            (from.HasValue && from.Value.Offset != TimeSpan.Zero) ||
            (to.HasValue && to.Value.Offset != TimeSpan.Zero) ||
            nextCursor is { Length: > 2048 }) return BadRequest("Invalid history scope.");
        var protector = protection.CreateProtector("CabinetPlatform.Connectivity.AcceptedHistory.v1");
        HistoryCursor? cursor = null;
        if (nextCursor is not null)
        {
            if (nextCursor.Length == 0) return BadRequest("Invalid history cursor.");
            try
            {
                if (WebEncoders.Base64UrlEncode(WebEncoders.Base64UrlDecode(nextCursor)) != nextCursor)
                    return BadRequest("Invalid history cursor.");
                cursor = JsonSerializer.Deserialize<HistoryCursor>(protector.Unprotect(nextCursor));
            }
            catch (Exception ex) when (ex is CryptographicException or FormatException or JsonException)
            {
                return BadRequest("Invalid history cursor.");
            }
            if (cursor is null || cursor.Version != 1 || cursor.Source != sourceId ||
                cursor.Target != targetId || (from is not null && from != cursor.From) ||
                (to is not null && to != cursor.To) || cursor.AsOf > now ||
                cursor.LastObserved < cursor.From || cursor.LastObserved > cursor.To || cursor.LastId == Guid.Empty)
                return BadRequest("History cursor does not match the requested scope.");
        }
        var asOf = cursor?.AsOf ?? now;
        var start = cursor?.From ?? from ?? asOf.AddHours(-24);
        var end = cursor?.To ?? to ?? asOf;
        if (start.Offset != TimeSpan.Zero || end.Offset != TimeSpan.Zero || start >= end ||
            end > asOf || end < asOf.AddDays(-30) || start < asOf.AddDays(-30) ||
            end - start > TimeSpan.FromDays(30)) return BadRequest("History window must be UTC and within the last 30 days.");
        if (!await db.Cabinets.AsNoTracking().AnyAsync(c => c.Id == sourceId, ct)) return NotFound();

        // ReceivedUtc is the upper watermark: a delayed replay accepted after the first
        // page cannot be inserted into a continuation. Retention can still remove rows.
        var query = db.ConnectivityEvidence.AsNoTracking().Where(e => e.SourceCabinetId == sourceId &&
            e.ObservedUtc >= start && e.ObservedUtc <= end && e.ReceivedUtc <= asOf);
        if (targetId is { } target) query = query.Where(e => e.TargetCabinetId == target);
        if (cursor is not null)
            query = query.Where(e => e.ObservedUtc < cursor.LastObserved ||
                (e.ObservedUtc == cursor.LastObserved && e.Id.CompareTo(cursor.LastId) < 0));
        var rows = await query.OrderByDescending(e => e.ObservedUtc).ThenByDescending(e => e.Id)
            .Take(pageSize + 1).ToArrayAsync(ct);
        var items = rows.Take(pageSize).Select(ProjectHistory).ToArray();
        string? continuation = rows.Length > pageSize
            ? protector.Protect(JsonSerializer.Serialize(new HistoryCursor(1, sourceId, targetId, start, end,
                asOf, rows[pageSize - 1].ObservedUtc, rows[pageSize - 1].Id))) : null;
        await audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.ViewConnectivity, EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success, ActorType = ActorType.User,
            ActorId = CurrentUser.UserId.ToString(), CabinetId = sourceId,
            Details = new { TargetCabinetId = targetId, FromUtc = start, ToUtc = end, Count = items.Length }
        }, ct);
        return Ok(new ConnectivityHistoryPage
        {
            SourceCabinetId = sourceId, TargetCabinetId = targetId, AsOfUtc = asOf,
            FromUtc = start, ToUtc = end, Items = items, NextCursor = continuation
        });
    }

    private static ConnectivityHistoryItem ProjectHistory(ConnectivityEvidence row)
    {
        ConnectivitySummary? summary = null;
        try
        {
            if (row.SummaryJson.Length <= 4096)
                summary = JsonSerializer.Deserialize<ConnectivitySummary>(row.SummaryJson, Json);
        }
        catch (JsonException) { }
        // Keep the immutable database identity but never expose agent-provided JSON or
        // counters unless the serialized interval agrees with the accepted row.
        if (summary is not null && summary.Id == row.Id && summary.SourceCabinetId == row.SourceCabinetId &&
            summary.TargetCabinetId == row.TargetCabinetId && summary.ConfigurationId == row.ConfigurationId &&
            summary.FirstObservedUtc == row.FirstObservedUtc && summary.LastObservedUtc == row.ObservedUtc &&
            ConnectivityClassifier.IsValid(summary, row.ObservedUtc.AddMinutes(1)))
            return new ConnectivityHistoryItem
            {
                Id = row.Id, SourceCabinetId = row.SourceCabinetId, TargetCabinetId = row.TargetCabinetId,
                ConfigurationId = row.ConfigurationId, FirstObservedUtc = row.FirstObservedUtc,
                LastObservedUtc = row.ObservedUtc, ReceivedUtc = row.ReceivedUtc,
                SuccessCount = summary.SuccessCount, FailureCount = summary.FailureCount, ErrorCount = summary.ErrorCount,
                LastSuccessUtc = summary.LastSuccessUtc, LastFailureUtc = summary.LastFailureUtc,
                SourceFirewallCheck = summary.SourceFirewallCheck
            };
        return new ConnectivityHistoryItem
        {
            Id = row.Id, SourceCabinetId = row.SourceCabinetId, TargetCabinetId = row.TargetCabinetId,
            ConfigurationId = row.ConfigurationId, FirstObservedUtc = row.FirstObservedUtc,
            LastObservedUtc = row.ObservedUtc, ReceivedUtc = row.ReceivedUtc, EvidenceUnavailable = true
        };
    }
}

using System.Text;
using System.Text.Json;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

/// <summary>Cabinet-bound, read-only saved process observations.</summary>
[ApiController]
[Route("api/cabinets/{cabinetId:guid}/process-results")]
public sealed class ProcessResultsController : ControllerBase
{
    private const int MaxProcesses = 200;
    private const int MaxStoredBytes = 512 * 1024;
    private const int MaxResponseBytes = 64 * 1024;
    private readonly SupportDbContext _db;

    public ProcessResultsController(SupportDbContext db) => _db = db;

    [HttpGet("latest")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(ProcessLatestResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<ProcessLatestResult>> Latest(Guid cabinetId, CancellationToken ct) =>
        ProjectResponse(await _db.ActionRequests.AsNoTracking()
            .Where(a => a.CabinetId == cabinetId && a.Action == ActionName.GetProcessList)
            .OrderByDescending(a => a.RequestedUtc).ThenByDescending(a => a.Id)
            .FirstOrDefaultAsync(ct));

    [HttpGet("{actionId:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    [ProducesResponseType(typeof(ProcessLatestResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<ProcessLatestResult>> ByAction(Guid cabinetId, Guid actionId, CancellationToken ct) =>
        ProjectResponse(await _db.ActionRequests.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Id == actionId && a.CabinetId == cabinetId &&
                a.Action == ActionName.GetProcessList, ct));

    private ActionResult<ProcessLatestResult> ProjectResponse(ActionRequest? action)
    {
        if (action is null) return NotFound();
        try { return Ok(Project(action)); }
        catch (Exception ex) when (ex is JsonException or ArgumentException or InvalidOperationException)
        {
            // Agent output is untrusted; never echo it or its parse error to a browser.
            return StatusCode(StatusCodes.Status502BadGateway);
        }
    }

    private static ProcessLatestResult Project(ActionRequest action)
    {
        bool completed = action.Status == ActionRequestStatus.Completed;
        bool success = completed && action.ResultStatus == ActionStatus.Succeeded;
        string state = completed || action.Status is ActionRequestStatus.Denied or ActionRequestStatus.Expired or ActionRequestStatus.Cancelled
            ? "failed" : "pending";
        var processes = new List<ProcessDisplayResult>();
        bool truncated = false;
        if (success)
        {
            string raw = action.CollectedDataJson ?? throw new JsonException("Missing process result.");
            if (Encoding.UTF8.GetByteCount(raw) > MaxStoredBytes) throw new JsonException("Process result too large.");
            using JsonDocument doc = JsonDocument.Parse(raw, new JsonDocumentOptions { MaxDepth = 32 });
            if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new JsonException("Expected process array.");
            var pids = new HashSet<int>();
            int count = 0;
            foreach (JsonElement row in doc.RootElement.EnumerateArray())
            {
                count++;
                if (row.ValueKind != JsonValueKind.Object) throw new JsonException("Invalid process row.");
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (JsonProperty property in row.EnumerateObject())
                    if (!names.Add(property.Name)) throw new JsonException("Duplicate process field.");
                if (!row.TryGetProperty("name", out JsonElement nameValue) ||
                    nameValue.ValueKind != JsonValueKind.String || nameValue.GetString() is not { } name ||
                    string.IsNullOrWhiteSpace(name) || name.Length > 256 || name.Any(char.IsControl) ||
                    name.Contains('/') || name.Contains('\\') ||
                    !row.TryGetProperty("pid", out JsonElement pidValue) ||
                    pidValue.ValueKind != JsonValueKind.Number || !pidValue.TryGetInt32(out int pid) || pid < 0 ||
                    !pids.Add(pid))
                    throw new JsonException("Invalid process identity.");
                double? cpu = OptionalDouble(row, "cpuPercent");
                long? memory = OptionalLong(row, "workingSetBytes");
                int? threads = OptionalInt(row, "threadCount");
                int? handles = OptionalInt(row, "handleCount");
                if (cpu is < 0 or > 100 || memory is < 0 || threads is < 0 || handles is < 0)
                    throw new JsonException("Invalid process counter.");
                if (count <= MaxProcesses)
                    processes.Add(new ProcessDisplayResult { Name = name, Pid = pid, CpuPercent = cpu,
                        WorkingSetBytes = memory, ThreadCount = threads, HandleCount = handles });
            }
            truncated = count > MaxProcesses;
            state = "complete";
        }
        ProcessLatestResult Make() => new()
        {
            CabinetId = action.CabinetId, ActionId = action.Id, State = state,
            RequestedAtUtc = action.RequestedUtc, CompletedAtUtc = completed ? action.CompletedUtc : null,
            Truncated = truncated, Processes = processes
        };
        while (processes.Count > 0 && JsonSerializer.SerializeToUtf8Bytes(Make(), ContractJson.Default).Length > MaxResponseBytes)
        {
            processes.RemoveAt(processes.Count - 1);
            truncated = true;
        }
        if (JsonSerializer.SerializeToUtf8Bytes(Make(), ContractJson.Default).Length > MaxResponseBytes)
            throw new JsonException("Projection too large.");
        return Make();
    }

    private static double? OptionalDouble(JsonElement row, string key)
    {
        if (!row.TryGetProperty(key, out JsonElement value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out double number) || !double.IsFinite(number))
            throw new JsonException("Invalid counter.");
        return number;
    }

    private static long? OptionalLong(JsonElement row, string key)
    {
        if (!row.TryGetProperty(key, out JsonElement value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out long number)) throw new JsonException("Invalid counter.");
        return number;
    }

    private static int? OptionalInt(JsonElement row, string key)
    {
        if (!row.TryGetProperty(key, out JsonElement value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out int number)) throw new JsonException("Invalid counter.");
        return number;
    }
}

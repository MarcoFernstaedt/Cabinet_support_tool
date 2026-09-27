using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Connectivity;

/// <summary>Authenticated transport with explicit acknowledgment; cancellation never deletes evidence.</summary>
public sealed class ConnectivityDelivery(HttpClient http, ConnectivitySpool spool, ConnectivitySampler sampler)
{
    public async Task<bool> RefreshPlanAsync(DateTimeOffset now, CancellationToken ct)
    {
        using var response = await http.GetAsync("api/agent/connectivity/plan", ct);
        if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)
        {
            sampler.Revoke();
            return false;
        }
        response.EnsureSuccessStatusCode();
        ConnectivityPlan? plan;
        try { plan = await response.Content.ReadFromJsonAsync<ConnectivityPlan>(AgentJson.SerializerOptions, ct); }
        catch (System.Text.Json.JsonException) { sampler.Revoke(); throw; }
        if (plan is null) { sampler.Revoke(); return false; }
        sampler.ApplyPlan(plan, now);
        return true;
    }

    public async Task<bool> DeliverAsync(DateTimeOffset now, CancellationToken ct)
    {
        var summaries = spool.Peek(now);
        if (summaries.Count == 0) return true;
        using var response = await http.PostAsJsonAsync("api/agent/connectivity/summaries", summaries, AgentJson.SerializerOptions, ct);
        if (response.IsSuccessStatusCode)
        {
            spool.Acknowledge(summaries.Select(s => s.Id));
            return true;
        }
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            sampler.Revoke();
        // Invalid or superseded summaries cannot become valid on retry. Make the
        // loss explicit to the worker instead of silently presenting delivery success.
        if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Conflict)
        {
            spool.Acknowledge(summaries.Select(s => s.Id));
            throw new InvalidDataException("Connectivity evidence refused and discarded: invalid or superseded configuration/window.");
        }
        return false;
    }
}

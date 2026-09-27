using System.Net.Http;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Connectivity;

/// <summary>Sampling is independent of uplink backoff and heavyweight inventory collection.</summary>
public sealed class ConnectivityWorker(
    IAgentStateStore identity, IHttpClientFactory clients, IConnectivityProbe probe,
    IOptions<AgentOptions> options, IClock clock, ILogger<ConnectivityWorker> logger) : BackgroundService
{
    private Context? _context;
    private DateTimeOffset _nextPlan;
    private sealed record Context(Guid Source, ConnectivitySampler Sampler, ConnectivityDelivery Delivery, HttpClient Http);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.WhenAll(SamplingLoop(stoppingToken), DeliveryLoop(stoppingToken)); }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally { _context?.Http.Dispose(); }
    }

    private async Task SamplingLoop(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(60));
        do
        {
            try
            {
                var context = Volatile.Read(ref _context);
                var state = identity.Load();
                if (context is not null)
                {
                    if (!state.IsApproved || state.CabinetId != context.Source) context.Sampler.Revoke();
                    else await context.Sampler.SampleAsync(clock.UtcNow, ct);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception e) { logger.LogError(e, "Connectivity sampling failed; missing observations are not healthy."); }
        } while (await timer.WaitForNextTickAsync(ct));
    }

    private async Task DeliveryLoop(CancellationToken ct)
    {
        int failures = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                bool completed = await DeliveryTickAsync(ct);
                failures = completed ? 0 : Math.Min(5, failures + 1);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception e)
            {
                failures = Math.Min(5, failures + 1);
                logger.LogWarning(e, "Connectivity delivery unavailable; unacknowledged summaries remain bounded by retention.");
            }
            // A healthy loop checks for aggregates, not individual failures. No empty uploads.
            double seconds = failures == 0 ? 30 : Math.Min(300, 30 * Math.Pow(2, failures));
            await Task.Delay(TimeSpan.FromSeconds(seconds * (0.9 + Random.Shared.NextDouble() * 0.2)), ct);
        }
    }

    public async Task<bool> DeliveryTickAsync(CancellationToken ct)
    {
        var state = identity.Load();
        if (!state.IsApproved || state.CabinetId is null || state.CabinetId == Guid.Empty)
        {
            _context?.Sampler.Revoke();
            return true;
        }
        var now = clock.UtcNow;
        if (_context?.Source != state.CabinetId)
        {
            var spool = new ConnectivitySpool(Path.Combine(options.Value.StateDirectory, "connectivity", state.CabinetId.Value.ToString("N")));
            var sampler = new ConnectivitySampler(state.CabinetId.Value, probe, summary => spool.Enqueue(summary, clock.UtcNow));
            var http = clients.CreateClient(AgentHttpClients.Server);
            http.Timeout = TimeSpan.FromSeconds(10);
            http.MaxResponseContentBufferSize = 32768;
            var previous = _context;
            Volatile.Write(ref _context, new Context(state.CabinetId.Value, sampler, new ConnectivityDelivery(http, spool, sampler), http));
            previous?.Sampler.Revoke();
            previous?.Http.Dispose();
            _nextPlan = default;
        }
        var context = _context;
        if (now >= _nextPlan)
        {
            if (!await context.Delivery.RefreshPlanAsync(now, ct)) return false;
            _nextPlan = now.AddMinutes(3);
        }
        return await context.Delivery.DeliverAsync(now, ct);
    }
}

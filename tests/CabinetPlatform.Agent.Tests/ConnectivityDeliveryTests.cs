using System.Net;
using CabinetPlatform.Agent.Connectivity;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Tests;

public sealed class ConnectivityDeliveryTests
{
    [Fact]
    public async Task Malformed_plan_body_revokes_prior_authorization_before_probing_again()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"connectivity-plan-{Guid.NewGuid():N}");
        try
        {
            var now = DateTimeOffset.UtcNow;
            var source = Guid.NewGuid();
            var probe = new ConnectivitySamplerTests.SequenceProbe(ProbeObservation.Reply);
            var sampler = new ConnectivitySampler(source, probe, _ => true);
            sampler.ApplyPlan(ConnectivitySamplerTests.Plan(source, now), now);
            using var http = new HttpClient(new ResponseHandler("{broken", HttpStatusCode.OK)) { BaseAddress = new Uri("https://synthetic.invalid") };
            var delivery = new ConnectivityDelivery(http, new ConnectivitySpool(directory), sampler);
            await Assert.ThrowsAsync<System.Text.Json.JsonException>(() => delivery.RefreshPlanAsync(now, default));
            await sampler.SampleAsync(now, default);
            Assert.Equal(0, probe.Calls);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task Caller_cancellation_does_not_acknowledge_durable_interval()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"connectivity-cancel-{Guid.NewGuid():N}");
        try
        {
            var now = DateTimeOffset.UtcNow;
            var summary = new ConnectivitySummary { Id = Guid.NewGuid(), FirstObservedUtc = now.AddMinutes(-2), LastObservedUtc = now };
            var spool = new ConnectivitySpool(directory);
            Assert.True(spool.Enqueue(summary, now));
            var sampler = new ConnectivitySampler(Guid.NewGuid(), new ConnectivitySamplerTests.SequenceProbe(ProbeObservation.Reply), _ => true);
            using var http = new HttpClient(new ResponseHandler("{}", HttpStatusCode.OK)) { BaseAddress = new Uri("https://synthetic.invalid") };
            var delivery = new ConnectivityDelivery(http, spool, sampler);
            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => delivery.DeliverAsync(now, cancelled.Token));
            Assert.Equal(summary.Id, Assert.Single(new ConnectivitySpool(directory).Peek(now)).Id);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private sealed class ResponseHandler(string json, HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") });
        }
    }
}

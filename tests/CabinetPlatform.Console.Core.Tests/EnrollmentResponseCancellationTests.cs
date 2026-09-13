using System.Net;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Contracts.Registrations;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class EnrollmentResponseCancellationTests
{
    [Theory]
    [InlineData(true, "cancel")]
    [InlineData(true, "http")]
    [InlineData(true, "io")]
    [InlineData(false, "cancel")]
    [InlineData(false, "http")]
    [InlineData(false, "io")]
    public async Task Caller_cancellation_during_body_read_remains_cancellation(bool approve, string fault)
    {
        using var cancellation = new CancellationTokenSource();
        using var http = new HttpClient(new BodyHandler(approve, new CancelledStream(cancellation, fault)))
        {
            BaseAddress = new Uri("https://console.test/")
        };
        var api = new ApiClient(http, new SessionStore());
        var exception = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => approve
            ? api.ApproveRegistrationAsync(Guid.NewGuid(), new ApproveRegistrationRequest
            {
                ClientName = "Synthetic", SiteName = "Synthetic",
                Role = CabinetPlatform.Contracts.Cabinets.CabinetRole.Standalone
            }, cancellation.Token)
            : api.RejectRegistrationAsync(Guid.NewGuid(), new RejectRegistrationRequest
            {
                Reason = "Synthetic"
            }, cancellation.Token));
        Assert.Equal(cancellation.Token, exception.CancellationToken);
    }

    [Fact]
    public async Task Rejection_204_is_confirmed_by_headers_without_consuming_a_nonexistent_body()
    {
        using var cancellation = new CancellationTokenSource();
        using var http = new HttpClient(new BodyHandler(false, new CancelledStream(cancellation, "io"), HttpStatusCode.NoContent))
        {
            BaseAddress = new Uri("https://console.test/")
        };
        var api = new ApiClient(http, new SessionStore());
        await api.RejectRegistrationAsync(Guid.NewGuid(), new RejectRegistrationRequest { Reason = "Synthetic" }, cancellation.Token);
        Assert.False(cancellation.IsCancellationRequested);
    }

    private sealed class BodyHandler(bool approve, Stream body, HttpStatusCode? status = null) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(status ?? (approve ? HttpStatusCode.OK : HttpStatusCode.BadGateway))
            {
                Content = new StreamContent(body)
            });
    }

    private sealed class CancelledStream(CancellationTokenSource cancellation, string fault) : MemoryStream
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            cancellation.Cancel();
            Exception exception = fault switch
            {
                "http" => new HttpRequestException("Synthetic cancelled connection"),
                "io" => new IOException("Synthetic cancelled stream"),
                _ => new OperationCanceledException(cancellation.Token)
            };
            return ValueTask.FromException<int>(exception);
        }
    }
}

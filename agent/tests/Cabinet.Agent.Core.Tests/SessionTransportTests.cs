using System.Net;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Core.Tests;

public sealed class SessionTransportTests
{
    [Fact]
    public async Task Frames_use_outbound_client_without_opening_a_listener()
    {
        using var key = ECDsa.Create();
        using var ca = new CertificateRequest("CN=test", key, HashAlgorithmName.SHA256)
            .CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        var id = Guid.NewGuid();
        using var client = new AgentApiClient(new Uri("https://platform.test"), ca, ca, _ => new Handler(id));
        var before = IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Select(x => x.ToString()).Order().ToArray();
        Assert.Equal(new byte[] { 0, 255 }, await client.ExchangeSessionFrameAsync(id, Encoding.UTF8.GetBytes("not.a.catalog.operation"), CancellationToken.None));
        var after = IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Select(x => x.ToString()).Order().ToArray();
        Assert.Equal(before, after);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => client.ExchangeSessionFrameAsync(id, new byte[16_385], CancellationToken.None));
    }

    private sealed class Handler(Guid sessionId) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal($"/agent/v1/sessions/{sessionId:D}/frames", request.RequestUri!.AbsolutePath);
            Assert.Contains(Convert.ToBase64String(Encoding.UTF8.GetBytes("not.a.catalog.operation")), await request.Content!.ReadAsStringAsync(token));
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"data\":\"AP8=\"}", Encoding.UTF8, "application/json") };
        }
    }
}

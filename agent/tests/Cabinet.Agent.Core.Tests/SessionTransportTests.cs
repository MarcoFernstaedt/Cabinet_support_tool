using System.Net;
using System.Reflection;
using System.Reflection.Emit;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Core.Tests;

public sealed class SessionTransportTests
{
    private static X509Certificate2 Certificate()
    {
        using var key = ECDsa.Create();
        return new CertificateRequest("CN=test", key, HashAlgorithmName.SHA256)
            .CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
    }

    [Fact]
    public async Task Outbound_frames_accept_only_fixed_controls_and_pin_16384_byte_limit()
    {
        using var ca = Certificate();
        var id = Guid.NewGuid();
        using var client = new AgentApiClient(new Uri("https://platform.test"), ca, ca, _ => new Handler(id, "{\"control\":\"keepalive\"}"));
        Assert.Equal("keepalive", (await client.ExchangeSessionFrameAsync(id, new byte[16_384], CancellationToken.None)).Control);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => client.ExchangeSessionFrameAsync(id, new byte[16_385], CancellationToken.None));
    }

    [Theory]
    [InlineData("{\"data\":\"!bad-base64!\"}")]
    [InlineData("{\"data\":\"AP8=\"}")]
    [InlineData("{\"control\":\"shell\"}")]
    [InlineData("{\"control\":\"open\",\"data\":\"AP8=\"}")]
    public async Task Responses_with_bytes_bad_base64_or_payload_controls_are_refused(string response)
    {
        using var ca = Certificate();
        var id = Guid.NewGuid();
        using var client = new AgentApiClient(new Uri("https://platform.test"), ca, ca, _ => new Handler(id, response));
        await Assert.ThrowsAsync<AgentApiException>(() => client.ExchangeSessionFrameAsync(id, [], CancellationToken.None));
    }

    [Fact]
    public void Agent_core_and_contract_IL_has_no_managed_listener_calls_even_transient_ones()
    {
        // Scan every Core/Contracts type, including helpers and async state machines, so a helper cannot conceal a
        // listener opened and closed inside a call. This checks managed IL, not native code or HttpClient internals.
        AssertNoListenerCalls(typeof(AgentApiClient).Assembly.GetTypes().Concat(typeof(Cabinet.Agent.Contracts.SessionControl).Assembly.GetTypes()));
    }

    [Fact]
    public void Listener_IL_guard_rejects_a_transient_listener_positive_control_without_running_it()
    {
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertNoListenerCalls([typeof(TransientListenerMutation)]));
    }

    private static void AssertNoListenerCalls(IEnumerable<Type> types)
    {
        var codes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.FieldType == typeof(OpCode)).Select(f => (OpCode)f.GetValue(null)!).ToDictionary(o => unchecked((ushort)o.Value));
        foreach (var type in types)
        foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly).Cast<MethodBase>().Concat(type.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)))
        {
            var il = method.GetMethodBody()?.GetILAsByteArray();
            if (il is null) continue;
            for (int i = 0; i < il.Length;)
            {
                ushort code = il[i++];
                if (code == 0xfe) code = (ushort)(0xfe00 | il[i++]);
                var op = codes[code];
                if (op.OperandType == OperandType.InlineMethod)
                {
                    var called = method.Module.ResolveMethod(BitConverter.ToInt32(il, i), type.GetGenericArguments(), method.IsGenericMethod ? method.GetGenericArguments() : null);
                    string owner = called?.DeclaringType?.FullName ?? "";
                    Assert.False(owner is "System.Net.Sockets.TcpListener" or "System.Net.HttpListener", $"{method} calls {called}");
                    Assert.False(owner == "System.Net.Sockets.Socket" && called?.Name is "Bind" or "Listen", $"{method} calls {called}");
                }
                i += op.OperandType switch {
                    OperandType.InlineNone => 0,
                    OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                    OperandType.InlineVar => 2,
                    OperandType.InlineI8 or OperandType.InlineR => 8,
                    OperandType.InlineSwitch => 4 + 4 * BitConverter.ToInt32(il, i),
                    _ => 4,
                };
            }
        }
    }

    private static class TransientListenerMutation
    {
        // Never executed. This mutation represents exactly what the old before/after snapshot missed.
        public static void OpenAndClose()
        {
            var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            listener.Stop();
        }
    }

    private sealed class Handler(Guid sessionId, string response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal($"/agent/v1/sessions/{sessionId:D}/frames", request.RequestUri!.AbsolutePath);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(response, Encoding.UTF8, "application/json") });
        }
    }
}

using System.Collections.Concurrent;
using System.IO.Compression;
using System.Net;
using System.Text;

namespace Cabinet.Agent.Core.Tests;

/// <summary>One request the agent sent to the fake server, as the server saw it (gzip bodies unpacked).</summary>
public sealed record SeenRequest(HttpMethod Method, string Path, string Query, string Body, bool Gzipped, Version Version, HttpVersionPolicy Policy, int HandlerNumber)
{
    public JsonNode? Json => Body.Length == 0 ? null : JsonNode.Parse(Body);
}

/// <summary>
/// An in-process stand-in for the platform server, plugged in through the connection's handler factory, so the
/// real client and connection code run against scripted (and hostile) answers. Each route is a function the test
/// replaces; the defaults answer like a healthy 1.0 server.
/// </summary>
public sealed class FakeServer
{
    public const string ServerTime = "2026-10-17T12:00:00Z";
    public ConcurrentQueue<SeenRequest> Requests { get; } = new();
    public int HandlersCreated;

    public Func<SeenRequest, CancellationToken, Task<HttpResponseMessage>> Heartbeat { get; set; } = (_, _) => Task.FromResult(Json($$$"""{"serverTime":"{{{ServerTime}}}","scanner":{"hardwareIds":null}}"""));
    /// <summary>Default: hold the poll a little, then answer with nothing.</summary>
    public Func<SeenRequest, CancellationToken, Task<HttpResponseMessage>> Commands { get; set; } = async (_, t) => { await Task.Delay(100, t); return Json($$"""{"serverTime":"{{ServerTime}}","commands":[]}"""); };
    /// <summary>Default: accept the enrollment as pending, the way the platform does while an administrator decides.</summary>
    public Func<SeenRequest, CancellationToken, Task<HttpResponseMessage>> Enroll { get; set; } =
        (_, _) => Task.FromResult(Json($$"""{"requestId":"{{Guid.NewGuid():D}}","status":"pending","serverTime":"{{ServerTime}}"}"""));
    public Func<SeenRequest, CancellationToken, Task<HttpResponseMessage>> Results { get; set; } = (_, _) => Task.FromResult(Ack());
    public Func<SeenRequest, CancellationToken, Task<HttpResponseMessage>> Events { get; set; } = (_, _) => Task.FromResult(Ack());
    public Func<SeenRequest, CancellationToken, Task<HttpResponseMessage>> Config { get; set; } = (_, _) => Task.FromResult(Ack());
    public Func<SeenRequest, CancellationToken, Task<HttpResponseMessage>> Renew { get; set; } = (_, _) => Task.FromResult(Status(HttpStatusCode.NotFound));

    public IEnumerable<SeenRequest> To(string path) => Requests.Where(r => r.Path == path);

    public static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Ack() => Json($$"""{"serverTime":"{{ServerTime}}"}""");

    public static HttpResponseMessage Status(HttpStatusCode status, TimeSpan? retryAfter = null)
    {
        var response = Json("""{"error":"refused"}""", status);
        if (retryAfter is { } r) response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(r);
        return response;
    }

    public static HttpResponseMessage CommandsAnswer(params JsonNode[] commands) =>
        Json(new JsonObject { ["serverTime"] = ServerTime, ["commands"] = new JsonArray(commands.Select(c => c.DeepClone()).ToArray()) }.ToJsonString());

    public HttpMessageHandler Handler(System.Security.Cryptography.X509Certificates.X509Certificate2? _) => new ScriptedHandler(this, Interlocked.Increment(ref HandlersCreated));

    private sealed class ScriptedHandler(FakeServer server, int number) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            string body = "";
            bool gzipped = false;
            if (request.Content is not null)
            {
                byte[] bytes = await request.Content.ReadAsByteArrayAsync(token);
                gzipped = request.Content.Headers.ContentEncoding.Contains("gzip");
                if (gzipped)
                {
                    using var input = new GZipStream(new MemoryStream(bytes), CompressionMode.Decompress);
                    using var output = new MemoryStream();
                    await input.CopyToAsync(output, token);
                    bytes = output.ToArray();
                }
                body = Encoding.UTF8.GetString(bytes);
            }
            Uri uri = request.RequestUri!;
            var seen = new SeenRequest(request.Method, uri.AbsolutePath, uri.Query, body, gzipped, request.Version, request.VersionPolicy, number);
            server.Requests.Enqueue(seen);
            return uri.AbsolutePath switch
            {
                "/agent/v1/heartbeat" => await server.Heartbeat(seen, token),
                "/agent/v1/enroll" => await server.Enroll(seen, token),
                "/agent/v1/commands" => await server.Commands(seen, token),
                "/agent/v1/results" => await server.Results(seen, token),
                "/agent/v1/events" => await server.Events(seen, token),
                "/agent/v1/config" => await server.Config(seen, token),
                "/agent/v1/renew" => await server.Renew(seen, token),
                _ => Status(HttpStatusCode.NotFound),
            };
        }
    }
}

using System.Buffers.Binary;
using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core;

/// <summary>
/// Framing on the broker pipe: a 4-byte little-endian length, then that many
/// bytes of UTF-8 JSON. One request, one response.
/// </summary>
public static class BrokerFraming
{
    public const string PipeName = "Mashura.CabinetAgent.Broker";
    public const int MaxRequestBytes = 64 * 1024;
    public const int MaxResponseBytes = 2 * 1024 * 1024;

    public static async Task WriteAsync(Stream stream, ReadOnlyMemory<byte> payload, CancellationToken token)
    {
        byte[] header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await stream.WriteAsync(header, token).ConfigureAwait(false);
        await stream.WriteAsync(payload, token).ConfigureAwait(false);
        await stream.FlushAsync(token).ConfigureAwait(false);
    }

    /// <returns>The payload, or null if the peer sent nothing, an oversize length or a short frame.</returns>
    public static async Task<byte[]?> ReadAsync(Stream stream, int maxBytes, CancellationToken token)
    {
        byte[] header = new byte[4];
        if (!await ReadExactlyAsync(stream, header, token).ConfigureAwait(false)) return null;
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length <= 0 || length > maxBytes) return null;
        byte[] payload = new byte[length];
        return await ReadExactlyAsync(stream, payload, token).ConfigureAwait(false) ? payload : null;
    }

    private static async Task<bool> ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken token)
    {
        int read = 0;
        while (read < buffer.Length)
        {
            int n = await stream.ReadAsync(buffer.AsMemory(read), token).ConfigureAwait(false);
            if (n == 0) return false;
            read += n;
        }
        return true;
    }
}

/// <summary>
/// The broker's side: validates every request again itself against
/// agent/broker-request.schema.json (which admits only the broker's own read
/// operations and their parameter schemas), runs it, and answers. Never throws
/// on bad input.
/// </summary>
public sealed class BrokerRequestHandler
{
    /// <summary>The only operations the broker performs in this version. Must match the schema's list.</summary>
    public static readonly IReadOnlyList<string> Operations = new[]
    {
        Catalog.EventlogChannels, Catalog.EventlogQuery, Catalog.EventlogGet, Catalog.UpdatesStatus, Catalog.DiskSmart, Catalog.FilesList,
    };

    private readonly OperationRegistry _registry;
    private readonly TimeSpan _timeout;

    public BrokerRequestHandler(OperationRegistry registry, TimeSpan? timeout = null)
    {
        foreach (string name in registry.Names)
            if (!Operations.Contains(name)) throw new ArgumentException($"The broker may not run {name}.");
        _registry = registry;
        _timeout = timeout ?? OperationRunner.DefaultTimeout;
    }

    /// <returns>The response bytes, or null when the request is unreadable and the connection should just close.</returns>
    public async Task<byte[]?> HandleAsync(byte[] requestBytes, CancellationToken token)
    {
        if (!StrictJson.TryParse(requestBytes, BrokerFraming.MaxRequestBytes, out JsonDocument? doc)) return null;
        using (doc)
        {
            JsonElement root = doc!.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("requestId", out JsonElement id) ||
                id.ValueKind != JsonValueKind.String || !Guid.TryParseExact(id.GetString(), "D", out Guid requestId))
                return null;
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Local("broker-request"), root))
                return Serialize(Failed(requestId, "invalid_params", "The broker refused a request that does not match its contract."));

            var request = root.Deserialize<BrokerRequest>(ContractJson.Options)!;
            if (request.Kind == BrokerRequestKind.Ping)
                return Serialize(new BrokerResponse
                {
                    RequestId = requestId, Status = BrokerStatus.Succeeded,
                    Output = JsonSerializer.SerializeToElement(new { broker = "ok" }),
                });

            var (output, error) = await OperationRunner.RunAsync(_registry, request.Operation!, request.Params!.Value, _timeout, token)
                .ConfigureAwait(false);
            return Serialize(error is null
                ? new BrokerResponse { RequestId = requestId, Status = BrokerStatus.Succeeded, Output = output }
                : new BrokerResponse { RequestId = requestId, Status = BrokerStatus.Failed, Error = error });
        }
    }

    private static BrokerResponse Failed(Guid id, string code, string message) =>
        new() { RequestId = id, Status = BrokerStatus.Failed, Error = new ResultError { Code = code, Message = message } };

    private static byte[] Serialize(BrokerResponse response) => JsonSerializer.SerializeToUtf8Bytes(response, ContractJson.Options);
}

/// <summary>
/// The network process's side. The transport (a locked-down named pipe on
/// Windows) is supplied by the caller; this class only frames, checks and
/// interprets the conversation.
/// </summary>
public sealed class BrokerClient
{
    private readonly Func<CancellationToken, Task<Stream>> _connect;

    public BrokerClient(Func<CancellationToken, Task<Stream>> connect) => _connect = connect;

    public async Task<bool> PingAsync(CancellationToken token)
    {
        try
        {
            BrokerResponse response = await SendAsync(new BrokerRequest { RequestId = Guid.NewGuid(), Kind = BrokerRequestKind.Ping }, token)
                .ConfigureAwait(false);
            return response.Status == BrokerStatus.Succeeded;
        }
        catch (OperationFailedException)
        {
            return false;
        }
    }

    /// <summary>Runs one broker operation and returns its output, already checked against the output schema.</summary>
    public async Task<JsonElement> RunAsync(string operation, JsonElement parameters, CancellationToken token)
    {
        BrokerResponse response = await SendAsync(new BrokerRequest
        {
            RequestId = Guid.NewGuid(), Kind = BrokerRequestKind.Operation, Operation = operation, Params = parameters,
        }, token).ConfigureAwait(false);
        if (response.Status == BrokerStatus.Failed)
            throw new OperationFailedException(response.Error!.Code, response.Error.Message);
        if (!ContractSchemas.Instance.IsValid(ContractSchemas.Output(operation), response.Output!.Value))
            throw new OperationFailedException("execution_failed", "The broker returned output that does not match the contract.");
        return response.Output.Value;
    }

    /// <summary>Registers every broker operation in <paramref name="registry"/> as a forward to the broker.</summary>
    public void RegisterForwarders(OperationRegistry registry)
    {
        foreach (string operation in BrokerRequestHandler.Operations)
            registry.RegisterRaw(operation, (p, t) => RunAsync(operation, p, t));
    }

    private async Task<BrokerResponse> SendAsync(BrokerRequest request, CancellationToken token)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(request, ContractJson.Options);
        using (JsonDocument check = JsonDocument.Parse(payload))
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Local("broker-request"), check.RootElement))
                throw new OperationFailedException("execution_failed", "The agent built a broker request that does not match its contract.");

        Stream stream;
        try
        {
            stream = await _connect(token).ConfigureAwait(false);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or TimeoutException)
        {
            throw new OperationFailedException("unavailable", "The agent's broker service is not reachable.");
        }
        await using (stream.ConfigureAwait(false))
        {
            byte[]? reply;
            try
            {
                await BrokerFraming.WriteAsync(stream, payload, token).ConfigureAwait(false);
                reply = await BrokerFraming.ReadAsync(stream, BrokerFraming.MaxResponseBytes, token).ConfigureAwait(false);
            }
            catch (IOException)
            {
                // The broker closed the pipe, which it does when it refuses the caller.
                throw new OperationFailedException("unavailable", "The broker closed the connection without a valid answer.");
            }
            if (reply is null || !StrictJson.TryParse(reply, BrokerFraming.MaxResponseBytes, out JsonDocument? doc))
                throw new OperationFailedException("unavailable", "The broker closed the connection without a valid answer.");
            using (doc)
            {
                if (!ContractSchemas.Instance.IsValid(ContractSchemas.Local("broker-response"), doc!.RootElement))
                    throw new OperationFailedException("execution_failed", "The broker's answer does not match its contract.");
                var response = doc.RootElement.Deserialize<BrokerResponse>(ContractJson.Options)!;
                if (response.RequestId != request.RequestId)
                    throw new OperationFailedException("execution_failed", "The broker answered a different request.");
                return response;
            }
        }
    }
}

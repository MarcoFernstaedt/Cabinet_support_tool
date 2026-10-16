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
/// agent/broker-request.schema.json (which admits only the broker's own
/// operations and their parameter schemas), runs it, and answers. Never throws
/// on bad input. Writes run with their command ID, and a confirm reports whether
/// the safety net kept or rolled back that command's change.
/// </summary>
public sealed class BrokerRequestHandler
{
    /// <summary>The only operations the broker performs: reads that need administrator rights, and every write. Must match the schema's list.</summary>
    public static readonly IReadOnlyList<string> Operations = new[]
    {
        Catalog.EventlogChannels, Catalog.EventlogQuery, Catalog.EventlogGet, Catalog.UpdatesStatus, Catalog.DiskSmart, Catalog.FilesList,
        Catalog.NetworkSetIp, Catalog.NetworkSetDns, Catalog.FirewallSetProfile, Catalog.FirewallApplyPolicy, Catalog.FirewallSetRule, Catalog.FirewallRestore,
        Catalog.PackageInstall, Catalog.DriverUninstall, Catalog.UpdatesUninstall,
        Catalog.ServicesList, Catalog.ProcessesList, Catalog.SystemPerformance, Catalog.NetworkListeners, Catalog.ServiceControl, Catalog.ServiceSetStartType,
        Catalog.SystemSecurity, Catalog.SoftwareList, Catalog.StartupList, Catalog.SessionsList, Catalog.SharesList, Catalog.ReliabilityList, Catalog.DiskFolders, Catalog.DnsCache, Catalog.PowerStatus, Catalog.SystemCheckHealth, Catalog.SystemRestart, Catalog.ProcessEnd, Catalog.PowerSet,
        Catalog.TimeStatus, Catalog.TimeSetZone, Catalog.TimeSync, Catalog.NetworkRenewLease, Catalog.NetworkFlushDns,
    };

    private readonly OperationRegistry _registry;
    private readonly TimeSpan _timeout;
    private readonly Func<Guid, SafetyNetStatus>? _confirm;
    private readonly Func<string, (JsonElement? Output, ResultError? Error)>? _upgrade;
    private readonly Services.ServiceWatcher? _watcher;
    private readonly Func<bool>? _readOnly;
    private readonly RateLimiter? _writeLimit;
    private readonly TimeProvider _clock;

    /// <param name="readOnly">Whether the cabinet's own configuration (written by an administrator at install) puts it in
    /// read-only mode. The broker checks it itself for every write: it does not take the network process's word.</param>
    /// <param name="writeLimit">The broker's own write limit, kept in a file only the broker can write, so a compromised
    /// network process cannot make more changes than the network process itself would allow.</param>
    /// <param name="confirm">Answers a confirm from the safety net; null when this broker makes no changes.</param>
    /// <param name="upgrade">Verifies a downloaded agent release and starts the updater; null when this broker installs no upgrades.</param>
    /// <param name="watcher">Keeps the watched services running; null when this broker watches none.</param>
    public BrokerRequestHandler(OperationRegistry registry, TimeSpan? timeout = null, Func<Guid, SafetyNetStatus>? confirm = null,
        Func<string, (JsonElement? Output, ResultError? Error)>? upgrade = null, Services.ServiceWatcher? watcher = null,
        Func<bool>? readOnly = null, RateLimiter? writeLimit = null, TimeProvider? clock = null)
    {
        _watcher = watcher;
        _readOnly = readOnly;
        _writeLimit = writeLimit;
        _clock = clock ?? TimeProvider.System;
        foreach (string name in registry.Names)
            if (!Operations.Contains(name)) throw new ArgumentException($"The broker may not run {name}.");
        _registry = registry;
        _timeout = timeout ?? OperationRunner.DefaultTimeout;
        _confirm = confirm;
        _upgrade = upgrade;
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

            if (request.Kind == BrokerRequestKind.Confirm)
            {
                SafetyNetStatus status = _confirm?.Invoke(request.CommandId!.Value)
                    ?? new SafetyNetStatus { CommandId = request.CommandId!.Value, State = SafetyNetState.Unknown };
                return Serialize(new BrokerResponse
                {
                    RequestId = requestId, Status = BrokerStatus.Succeeded, Output = JsonSerializer.SerializeToElement(status, ContractJson.Options),
                });
            }

            if (request.Kind is BrokerRequestKind.Watch or BrokerRequestKind.WatchStatus)
            {
                if (_watcher is null) return Serialize(Failed(requestId, "unavailable", "This broker watches no services."));
                if (request.Kind == BrokerRequestKind.Watch) _watcher.SetList(request.Services!);
                return Serialize(new BrokerResponse
                {
                    RequestId = requestId, Status = BrokerStatus.Succeeded,
                    Output = JsonSerializer.SerializeToElement(new ServiceWatch { Watched = _watcher.Status() }, ContractJson.Options),
                });
            }

            if (request.Kind == BrokerRequestKind.Upgrade)
            {
                if (_upgrade is null) return Serialize(Failed(requestId, "unavailable", "This broker installs no upgrades."));
                // Verifying a release reads and hashes the whole package and checks every binary: it runs off the pipe's thread.
                var (started, failure) = await Task.Run(() => _upgrade(request.Version!), token).ConfigureAwait(false);
                return Serialize(failure is null
                    ? new BrokerResponse { RequestId = requestId, Status = BrokerStatus.Succeeded, Output = started ?? JsonSerializer.SerializeToElement(new { started = true }) }
                    : new BrokerResponse { RequestId = requestId, Status = BrokerStatus.Failed, Error = failure });
            }

            bool write = Catalog.TryGet(request.Operation, out CatalogEntry entry) && entry.Kind == OperationKind.Write;
            if (write)
            {
                // Checked here again, by the broker itself: the network process may have been compromised.
                bool readOnly;
                try { readOnly = _readOnly?.Invoke() ?? false; }
                catch (Exception) { readOnly = true; } // a configuration the broker cannot read allows no changes
                if (readOnly) return Serialize(Failed(requestId, "read_only_mode", "This cabinet's agent is installed in read-only mode."));
                if (_writeLimit is not null && !_writeLimit.TryTake(RateClass.Write, _clock.GetUtcNow()))
                    return Serialize(Failed(requestId, "rate_limited", "The broker's own write limit for this hour is reached."));
            }
            // Writes take longer (an MSI install, a driver package): they get the limit for their kind.
            TimeSpan limit = write ? OperationRunner.BrokerTimeoutFor(request.Operation!) : _timeout;
            var (output, error) = await OperationContext.RunAsync(request.CommandId, () =>
                OperationRunner.RunAsync(_registry, request.Operation!, request.Params!.Value, limit, token)).ConfigureAwait(false);
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
        bool write = Catalog.TryGet(operation, out CatalogEntry entry) && entry.Kind == OperationKind.Write;
        if (write && OperationContext.CommandId is null)
            throw new OperationFailedException("execution_failed", "A write reached the broker without its command.");
        BrokerResponse response = await SendAsync(new BrokerRequest
        {
            RequestId = Guid.NewGuid(), Kind = BrokerRequestKind.Operation, Operation = operation, Params = parameters,
            CommandId = write ? OperationContext.CommandId : null,
        }, token).ConfigureAwait(false);
        if (response.Status == BrokerStatus.Failed)
            throw new OperationFailedException(response.Error!.Code, response.Error.Message);
        if (!ContractSchemas.Instance.IsValid(ContractSchemas.Output(operation), response.Output!.Value))
            throw new OperationFailedException("execution_failed", "The broker returned output that does not match the contract.");
        return response.Output.Value;
    }

    /// <summary>Tells the broker the server was reached after the command's change; the answer says whether the change is kept.</summary>
    public async Task<SafetyNetStatus> ConfirmAsync(Guid commandId, CancellationToken token)
    {
        BrokerResponse response = await SendAsync(new BrokerRequest { RequestId = Guid.NewGuid(), Kind = BrokerRequestKind.Confirm, CommandId = commandId }, token)
            .ConfigureAwait(false);
        if (response.Status == BrokerStatus.Failed || !ContractSchemas.Instance.IsValid(ContractSchemas.Local("safety-net-status"), response.Output!.Value))
            throw new OperationFailedException("execution_failed", "The broker's safety-net answer does not match its contract.");
        return response.Output.Value.Deserialize<SafetyNetStatus>(ContractJson.Options)!;
    }

    /// <summary>Asks the broker to verify and install a downloaded agent release, named by version only.</summary>
    /// <returns>Whether the updater started; otherwise the broker's error, with the check that refused the release.</returns>
    public async Task<(bool Ok, ResultError? Error)> UpgradeAsync(string version, CancellationToken token)
    {
        try
        {
            BrokerResponse response = await SendAsync(new BrokerRequest { RequestId = Guid.NewGuid(), Kind = BrokerRequestKind.Upgrade, Version = version }, token)
                .ConfigureAwait(false);
            return response.Status == BrokerStatus.Succeeded ? (true, null) : (false, response.Error);
        }
        catch (OperationFailedException e) { return (false, new ResultError { Code = e.Code, Message = e.Message, Check = UpgradeCheck.Install }); }
    }

    /// <summary>Hands the broker the services to keep running (null: just ask), and returns each one's status, checked against its schema.</summary>
    public async Task<IReadOnlyList<WatchedServiceStatus>> WatchAsync(IReadOnlyList<string>? names, CancellationToken token)
    {
        BrokerResponse response = await SendAsync(new BrokerRequest
        {
            RequestId = Guid.NewGuid(), Kind = names is null ? BrokerRequestKind.WatchStatus : BrokerRequestKind.Watch, Services = names,
        }, token).ConfigureAwait(false);
        if (response.Status == BrokerStatus.Failed)
            throw new OperationFailedException(response.Error!.Code, response.Error.Message);
        if (!ContractSchemas.Instance.IsValid(ContractSchemas.Local("service-watch"), response.Output!.Value))
            throw new OperationFailedException("execution_failed", "The broker's watch status does not match its contract.");
        return response.Output.Value.Deserialize<ServiceWatch>(ContractJson.Options)!.Watched;
    }

    /// <summary>Registers every broker operation in <paramref name="registry"/> as a forward to the broker.</summary>
    public void RegisterForwarders(OperationRegistry registry)
    {
        foreach (string operation in BrokerRequestHandler.Operations)
            if (!registry.Has(operation)) registry.RegisterRaw(operation, (p, t) => RunAsync(operation, p, t));
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

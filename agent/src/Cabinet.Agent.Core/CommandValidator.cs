using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core;

/// <summary>A command that passed all six checks.</summary>
public sealed record ValidatedCommand(Command Command, CatalogEntry Entry);

/// <summary>Why a command was refused. Messages are fixed text and never echo input.</summary>
public sealed record Rejection(string Code, string Message);

public abstract record ValidationOutcome
{
    /// <summary>Not even the command ID could be read, so no result can be addressed. Logged and dropped.</summary>
    public sealed record Unaddressable(string Reason) : ValidationOutcome;
    public sealed record Rejected(Guid CommandId, Rejection Rejection) : ValidationOutcome;
    public sealed record Accepted(ValidatedCommand Command) : ValidationOutcome;
}

/// <summary>
/// The six command checks, in the order docs/spec/04-agent-spec.md sets:
/// 1 operation in the catalog, 2 this cabinet, 3 not expired, 4 not replayed,
/// 5 parameters pass the schema, 6 for writes, not read-only and under the
/// write limit. Read and network-test limits are also checked at step 6.
/// Nothing runs unless every step passes.
/// </summary>
public sealed class CommandValidator
{
    /// <summary>Clock-skew tolerance between the server and the cabinet.</summary>
    public static readonly TimeSpan ClockSkew = TimeSpan.FromMinutes(2);
    public const int MaxCommandBytes = 256 * 1024;

    private static readonly string[] EnvelopeProperties = { "commandId", "cabinetId", "operation", "params", "issuedBy", "issuedAt", "expiresAt" };

    private readonly AgentConfig _config;
    private readonly ReplayStore _replay;
    private readonly RateLimiter _limits;
    private readonly TimeProvider _clock;
    private readonly ContractSchemas _schemas = ContractSchemas.Instance;

    private readonly Func<IReadOnlyList<LocalNetwork>> _localNetworks;

    /// <param name="localNetworks">The cabinet's connected IPv4 networks; defaults to what the operating system reports.</param>
    public CommandValidator(AgentConfig config, ReplayStore replay, RateLimiter limits, TimeProvider clock, Func<IReadOnlyList<LocalNetwork>>? localNetworks = null)
    {
        _localNetworks = localNetworks ?? LocalNetwork.Current;
        _config = config;
        _replay = replay;
        _limits = limits;
        _clock = clock;
    }

    public ValidationOutcome Validate(ReadOnlyMemory<byte> utf8)
    {
        if (!StrictJson.TryParse(utf8, MaxCommandBytes, out JsonDocument? doc))
            return new ValidationOutcome.Unaddressable("The command is not valid JSON, is too large or too deep, or repeats a property name.");
        using (doc)
            return Validate(doc!.RootElement);
    }

    public ValidationOutcome Validate(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("commandId", out JsonElement idElement) ||
            !_schemas.IsValid(ContractSchemas.CommandProperty("commandId"), idElement))
            return new ValidationOutcome.Unaddressable("The command has no readable command ID.");
        Guid commandId = Guid.Parse(idElement.GetString()!);
        ValidationOutcome Reject(string code, string message) => new ValidationOutcome.Rejected(commandId, new Rejection(code, message));

        // Step 1: the operation is in the compiled-in catalog (exact, case-sensitive).
        if (!root.TryGetProperty("operation", out JsonElement opElement) || opElement.ValueKind != JsonValueKind.String ||
            !Catalog.TryGet(opElement.GetString(), out CatalogEntry entry))
            return Reject("unknown_operation", "The operation is not in this agent's catalog.");

        // The rest of the envelope must be well formed before its fields can be trusted for steps 2 to 4.
        foreach (JsonProperty property in root.EnumerateObject())
            if (Array.IndexOf(EnvelopeProperties, property.Name) < 0)
                return Reject("invalid_params", "The command envelope has an unexpected field.");
        foreach (string name in EnvelopeProperties)
            if (!root.TryGetProperty(name, out JsonElement value) || !_schemas.IsValid(ContractSchemas.CommandProperty(name), value))
                return Reject("invalid_params", "The command envelope is missing a field or has a malformed one.");
        Command command = root.Deserialize<Command>(ContractJson.Options)!;

        // Step 2: addressed to this cabinet.
        if (command.CabinetId != _config.CabinetId)
            return Reject("wrong_cabinet", "The command is addressed to a different cabinet.");

        // Step 3: inside its lifetime, which may not exceed the catalog's expiry for the operation.
        DateTimeOffset now = _clock.GetUtcNow();
        if (command.ExpiresAt <= command.IssuedAt)
            return Reject("expired", "The command expires before it was issued.");
        if (command.ExpiresAt - command.IssuedAt > TimeSpan.FromSeconds(entry.ExpirySeconds))
            return Reject("expired", "The command's lifetime is longer than this operation allows.");
        if (command.IssuedAt > now + ClockSkew)
            return Reject("expired", "The command was issued in the future beyond the clock-skew tolerance.");
        if (now > command.ExpiresAt + ClockSkew)
            return Reject("expired", "The command has expired.");

        // Step 4: never seen before. Recorded now, so a resend of a command refused later is still a replay.
        switch (_replay.TryRecord(command.CommandId, command.ExpiresAt + ClockSkew, now))
        {
            case ReplayStore.Outcome.AlreadySeen:
                return Reject("replayed", "This command ID was already received.");
            case ReplayStore.Outcome.Full:
                return Reject("rate_limited", "Too many recent commands to track; try again shortly.");
        }

        // Step 5: parameters pass the operation's schema, then local policy the schema cannot know.
        if (!_schemas.IsValid(ContractSchemas.Params(entry.Name), command.Params) ||
            !_schemas.IsValid(ContractSchemas.Envelope("command"), root))
            return Reject("invalid_params", "The parameters do not match the operation's schema.");
        if (LocalPolicy(entry, command.Params) is { } policy)
            return Reject("invalid_params", policy);

        // Step 6: read-only mode and the local limits.
        if (entry.Kind == OperationKind.Write && _config.ReadOnlyMode)
            return Reject("read_only_mode", "This cabinet's agent is installed in read-only mode.");
        if (!_limits.TryTake(entry.RateClass, now))
            return Reject("rate_limited", entry.RateClass switch
            {
                RateClass.Write => "The cabinet's limit of 20 changes per hour is reached.",
                RateClass.NetworkTest => "The cabinet's limit of 10 network tests per minute is reached.",
                RateClass.NetworkTrace => "The cabinet's limit of 12 path traces per minute is reached.",
                _ => "The cabinet's limit of 60 reads per minute is reached.",
            });

        return new ValidationOutcome.Accepted(new ValidatedCommand(command, entry));
    }

    /// <summary>
    /// Rules the schema cannot know. TCP tests only to ports this cabinet allows
    /// locally, or, for the sync cabinet only, to the few ports its site's settings
    /// list. A sync address supplied by the server must be a private address on one
    /// of this cabinet's own networks, so a compromised server cannot aim tests elsewhere.
    /// </summary>
    private string? LocalPolicy(CatalogEntry entry, JsonElement parameters)
    {
        if (entry.Name == Catalog.NetworkTrace)
        {
            var t = parameters.Deserialize<NetworkTraceParams>(ContractJson.Options)!;
            return t.SyncAddress is { } a && !LocalNetwork.IsPrivateOnLocalNetwork(a, _localNetworks())
                ? "The sync cabinet address from the server is not a private address on this cabinet's own network." : null;
        }
        if (entry.Name != Catalog.NetworkTest) return null;
        var p = parameters.Deserialize<NetworkTestParams>(ContractJson.Options)!;
        if (p.SyncAddress is { } address && !LocalNetwork.IsPrivateOnLocalNetwork(address, _localNetworks()))
            return "The sync cabinet address from the server is not a private address on this cabinet's own network.";
        if (p.Method == NetworkTestMethod.Tcp)
        {
            bool allowed = _config.AllowedTcpPorts.Contains(p.Port!.Value) ||
                           (p.Target == NetworkTestTarget.SyncCabinet && p.SyncPorts?.Contains(p.Port.Value) == true);
            if (!allowed) return "TCP tests are allowed only to ports in this cabinet's configuration or its site's sync ports.";
        }
        return null;
    }
}

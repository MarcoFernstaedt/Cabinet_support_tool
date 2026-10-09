using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core;

/// <summary>
/// Thrown by an executor to end an operation with one of the failure codes.
/// The message is shown to support staff, so it is fixed text plus facts the
/// agent produced itself, never raw exception text from Windows.
/// </summary>
public sealed class OperationFailedException(string code, string message) : Exception(message)
{
    /// <summary>A failure code, or one of the package refusals (hash, signature, publisher), which are reported as rejections.</summary>
    public string Code { get; } = Catalog.FailureCodes.Contains(code) || PackageRefusals.Contains(code) ? code : "execution_failed";

    public static readonly IReadOnlyList<string> PackageRefusals = new[] { "hash_mismatch", "signature_invalid", "publisher_not_trusted", "verification_failed" };
}

/// <summary>
/// The platform command an operation is running for. Writes need it: the safety net, firewall
/// snapshots and firewall-change attribution all record which command made a change.
/// </summary>
public static class OperationContext
{
    private static readonly AsyncLocal<Guid?> Current = new();

    public static Guid? CommandId => Current.Value;

    /// <summary>Sets the command for the code that runs inside <paramref name="body"/> (and the tasks it starts).</summary>
    public static async Task<T> RunAsync<T>(Guid? commandId, Func<Task<T>> body)
    {
        Guid? previous = Current.Value;
        Current.Value = commandId;
        try { return await body().ConfigureAwait(false); }
        finally { Current.Value = previous; }
    }
}

/// <summary>
/// The handlers this process can run, keyed by catalog name. Registering a
/// name outside the catalog is a programming error and throws, so there is no
/// way to add an operation at run time.
/// </summary>
public sealed class OperationRegistry
{
    private readonly Dictionary<string, Func<JsonElement, CancellationToken, Task<JsonElement>>> _handlers = new(StringComparer.Ordinal);

    public OperationRegistry Register<TParams, TOutput>(string operation, Func<TParams, CancellationToken, Task<TOutput>> handler)
    {
        if (!Catalog.TryGet(operation, out CatalogEntry entry))
            throw new ArgumentException("Only catalog operations can be registered.", nameof(operation));
        if (entry.ParamsType != typeof(TParams) || entry.OutputType != typeof(TOutput))
            throw new ArgumentException("The handler's types do not match the catalog entry.", nameof(handler));
        _handlers.Add(operation, async (raw, token) =>
        {
            TParams parameters = raw.Deserialize<TParams>(ContractJson.Options)!;
            TOutput output = await handler(parameters, token).ConfigureAwait(false);
            return JsonSerializer.SerializeToElement(output, ContractJson.Options);
        });
        return this;
    }

    /// <summary>Forward an operation to another handler that already returns JSON (the broker client).</summary>
    public OperationRegistry RegisterRaw(string operation, Func<JsonElement, CancellationToken, Task<JsonElement>> handler)
    {
        if (!Catalog.TryGet(operation, out _))
            throw new ArgumentException("Only catalog operations can be registered.", nameof(operation));
        _handlers.Add(operation, handler);
        return this;
    }

    public bool Has(string operation) => _handlers.ContainsKey(operation);
    public IEnumerable<string> Names => _handlers.Keys;

    public bool TryGet(string operation, out Func<JsonElement, CancellationToken, Task<JsonElement>> handler) =>
        _handlers.TryGetValue(operation, out handler!);
}

/// <summary>
/// Runs one validated operation: dispatch, time limit, and output checked
/// against the operation's output schema before it leaves the process.
/// </summary>
public static class OperationRunner
{
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(90);

    /// <summary>
    /// How long the broker lets an operation run. Installs and driver removal run an installer with its own
    /// 10-minute limit plus the checks; other writes are quick; reads keep the default.
    /// </summary>
    public static TimeSpan BrokerTimeoutFor(string operation) => operation switch
    {
        Catalog.PackageInstall or Catalog.DriverUninstall => TimeSpan.FromMinutes(20),
        _ when Catalog.TryGet(operation, out CatalogEntry e) && e.Kind == OperationKind.Write => TimeSpan.FromMinutes(5),
        _ => DefaultTimeout,
    };

    /// <summary>
    /// How long the network service waits for a command: always longer than the broker's limit, so the broker's own
    /// answer (done, or timed out) is what gets reported, never a guess. A package install also downloads up to 500 MB first.
    /// </summary>
    public static TimeSpan NetworkTimeoutFor(string operation) => operation switch
    {
        Catalog.PackageInstall => TimeSpan.FromMinutes(29),
        _ when Catalog.TryGet(operation, out CatalogEntry e) && e.Kind == OperationKind.Write => BrokerTimeoutFor(operation) + TimeSpan.FromMinutes(1),
        _ => DefaultTimeout,
    };

    public static async Task<(JsonElement? Output, ResultError? Error)> RunAsync(
        OperationRegistry registry, string operation, JsonElement parameters, TimeSpan timeout, CancellationToken cancellation)
    {
        if (!registry.TryGet(operation, out var handler))
            return (null, new ResultError { Code = "unavailable", Message = "This operation is not available in this agent version." });

        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        limit.CancelAfter(timeout);
        try
        {
            // Run off the caller's thread so a handler that blocks in a Windows call still honours the time limit.
            Task<JsonElement> work = Task.Run(() => handler(parameters, limit.Token), limit.Token);
            Task finished = await Task.WhenAny(work, Task.Delay(Timeout.InfiniteTimeSpan, limit.Token)).ConfigureAwait(false);
            if (finished != work)
            {
                _ = work.ContinueWith(t => _ = t.Exception, TaskScheduler.Default);
                return (null, new ResultError { Code = "timeout", Message = "The operation did not finish within its time limit." });
            }
            JsonElement output = await work.ConfigureAwait(false);
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Output(operation), output))
                return (null, new ResultError { Code = "execution_failed", Message = "The operation produced output that does not match its contract." });
            return (output, null);
        }
        catch (OperationFailedException e)
        {
            return (null, new ResultError { Code = e.Code, Message = Truncate(e.Message) });
        }
        catch (OperationCanceledException) when (limit.IsCancellationRequested && !cancellation.IsCancellationRequested)
        {
            return (null, new ResultError { Code = "timeout", Message = "The operation did not finish within its time limit." });
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // Exception text from Windows can carry paths or user names; report the type only.
            return (null, new ResultError { Code = "execution_failed", Message = $"The operation failed ({e.GetType().Name})." });
        }
    }

    public static string Truncate(string message)
    {
        string clean = new(message.Where(c => !char.IsControl(c)).ToArray());
        return clean.Length <= 256 ? clean : clean[..256];
    }
}

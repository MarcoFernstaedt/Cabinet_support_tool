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
    public string Code { get; } = Catalog.FailureCodes.Contains(code) ? code : "execution_failed";
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

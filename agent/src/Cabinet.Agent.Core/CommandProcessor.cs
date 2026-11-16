using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core;

/// <summary>
/// Turns one raw command into one result: the six checks, then the operation,
/// then a result envelope that is itself checked against its schema.
/// </summary>
public sealed class CommandProcessor
{
    private readonly CommandValidator _validator;
    private readonly OperationRegistry _registry;
    private readonly TimeProvider _clock;

    public CommandProcessor(CommandValidator validator, OperationRegistry registry, TimeProvider clock)
    {
        _validator = validator;
        _registry = registry;
        _clock = clock;
    }

    public void RegisterSessionHandler(Func<SessionOpenParams, CancellationToken, Task<SessionOpenOutput>> handler) =>
        _registry.Register(Catalog.SessionOpen, handler);

    /// <summary>A fixed limit for every operation (tests); when unset each operation gets <see cref="OperationRunner.NetworkTimeoutFor"/>.</summary>
    public TimeSpan? Timeout { get; init; }

    /// <returns>The result, or null with a reason when the command cannot be addressed.</returns>
    public async Task<(Result? Result, string? DroppedReason)> ProcessAsync(ReadOnlyMemory<byte> utf8, CancellationToken cancellation)
    {
        DateTimeOffset started = _clock.GetUtcNow();
        switch (_validator.Validate(utf8))
        {
            case ValidationOutcome.Unaddressable u:
                return (null, u.Reason);
            case ValidationOutcome.Rejected r:
                return (Checked(new Result
                {
                    CommandId = r.CommandId, Status = ResultStatus.Rejected, StartedAt = started, FinishedAt = _clock.GetUtcNow(),
                    Error = new ResultError { Code = r.Rejection.Code, Message = r.Rejection.Message },
                }), null);
            case ValidationOutcome.Accepted a:
                var (output, error) = await OperationContext.RunAsync(a.Command.Command.CommandId, () => OperationRunner.RunAsync(
                    _registry, a.Command.Entry.Name, a.Command.Command.Params, Timeout ?? OperationRunner.NetworkTimeoutFor(a.Command.Entry.Name), cancellation)).ConfigureAwait(false);
                return (Checked(new Result
                {
                    CommandId = a.Command.Command.CommandId,
                    // A package that fails its hash, signature or publisher check was refused, not attempted.
                    Status = error is null ? ResultStatus.Succeeded : Catalog.RejectionCodes.Contains(error.Code) ? ResultStatus.Rejected : ResultStatus.Failed,
                    StartedAt = started, FinishedAt = _clock.GetUtcNow(), Output = output, Error = error,
                }), null);
            default:
                throw new InvalidOperationException();
        }
    }

    private static Result Checked(Result result)
    {
        JsonElement json = JsonSerializer.SerializeToElement(result, ContractJson.Options);
        IReadOnlyList<SchemaIssue> issues = ContractSchemas.Instance.Validate(ContractSchemas.Envelope("result"), json);
        if (issues.Count > 0)
            throw new InvalidOperationException("The agent built a result that does not match its contract: " +
                string.Join(", ", issues.Select(i => $"{i.Path} ({i.Rule})")));
        return result;
    }
}

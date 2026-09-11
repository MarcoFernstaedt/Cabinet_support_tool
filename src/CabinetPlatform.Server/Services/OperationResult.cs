namespace CabinetPlatform.Server.Services;

/// <summary>Why an operation was refused, mapped to an HTTP status by the controller.</summary>
public enum OperationFailure
{
    None = 0,
    NotFound,
    /// <summary>The caller is who they say, but may not do this.</summary>
    Forbidden,
    /// <summary>The request was malformed or violated a rule of the catalogue.</summary>
    Invalid,
    /// <summary>The request was well-formed but conflicts with current state.</summary>
    Conflict
}

/// <summary>
/// A refusal carries its reason as data rather than as an exception, because
/// every refusal in this server ends up in the audit trail and the reason is
/// the part a compliance reviewer will read.
/// </summary>
public class OperationResult
{
    protected OperationResult(bool succeeded, OperationFailure failure, string? reason)
    {
        Succeeded = succeeded;
        Failure = failure;
        Reason = reason;
    }

    public bool Succeeded { get; }
    public OperationFailure Failure { get; }
    public string? Reason { get; }

    public static OperationResult Ok() => new(true, OperationFailure.None, null);
    public static OperationResult NotFound(string reason) => new(false, OperationFailure.NotFound, reason);
    public static OperationResult Forbidden(string reason) => new(false, OperationFailure.Forbidden, reason);
    public static OperationResult Invalid(string reason) => new(false, OperationFailure.Invalid, reason);
    public static OperationResult Conflict(string reason) => new(false, OperationFailure.Conflict, reason);
}

public sealed class OperationResult<T> : OperationResult
{
    private OperationResult(bool succeeded, OperationFailure failure, string? reason, T? value)
        : base(succeeded, failure, reason)
    {
        Value = value;
    }

    public T? Value { get; }

    public static OperationResult<T> Ok(T value) => new(true, OperationFailure.None, null, value);

    public static new OperationResult<T> NotFound(string reason) =>
        new(false, OperationFailure.NotFound, reason, default);

    public static new OperationResult<T> Forbidden(string reason) =>
        new(false, OperationFailure.Forbidden, reason, default);

    public static new OperationResult<T> Invalid(string reason) =>
        new(false, OperationFailure.Invalid, reason, default);

    public static new OperationResult<T> Conflict(string reason) =>
        new(false, OperationFailure.Conflict, reason, default);
}

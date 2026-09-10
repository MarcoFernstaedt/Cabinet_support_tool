using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Actions;

/// <summary>
/// The outcome an agent reports for an <see cref="ActionRequestDto"/>.
/// </summary>
public sealed record ActionResultDto
{
    /// <summary>The <see cref="ActionRequestDto.Id"/> this result answers.</summary>
    public required Guid RequestId { get; init; }

    /// <summary>How the action ended.</summary>
    public required ActionStatus Status { get; init; }

    /// <summary>
    /// Human-readable outcome detail, for example the service state after a
    /// restart or the reason a failure occurred. Display only.
    /// </summary>
    public string? Output { get; init; }

    /// <summary>UTC instant the agent finished the action.</summary>
    public required DateTimeOffset CompletedAtUtc { get; init; }
}

/// <summary>
/// How an action ended.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ActionStatus
{
    /// <summary>The action completed successfully.</summary>
    Succeeded = 1,

    /// <summary>The action ran and failed.</summary>
    Failed = 2,

    /// <summary>The server refused the action. It never reached the agent.</summary>
    Denied = 3,

    /// <summary>The action did not report an outcome within its time limit.</summary>
    TimedOut = 4,

    /// <summary>
    /// The outcome is genuinely unknown: the agent restarted while the action
    /// was in flight, so it cannot say whether the action took effect. This is
    /// the case a reboot leaves behind.
    /// <para>
    /// An action in this state must never be retried automatically. A person
    /// establishes what actually happened and requests it again if needed.
    /// </para>
    /// </summary>
    UnknownResult = 5,
}

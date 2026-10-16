using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

// Support actions (docs/spec/04-agent-spec.md): restart or shut down, end a process, a Windows health check and two power settings.

public enum RestartMode { Restart, Shutdown, Cancel }

public sealed record SystemRestartParams
{
    public required RestartMode Mode { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public long? DelaySeconds { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Message { get; init; }
}

public sealed record SystemRestartOutput
{
    public required RestartMode Mode { get; init; }
    public required long? DelaySeconds { get; init; }
    public required DateTimeOffset? ScheduledFor { get; init; }
}

public sealed record ProcessEndParams
{
    public required long ProcessId { get; init; }
    public required string Name { get; init; }
}

public sealed record ProcessEndOutput
{
    public required long ProcessId { get; init; }
    public required string Name { get; init; }
    public required bool Ended { get; init; }
}

public enum ComponentStoreState { Healthy, Repairable, Corrupt, Unknown }

public sealed record SystemCheckHealthOutput
{
    public required ComponentStoreState State { get; init; }
    public required string Summary { get; init; }
    public required long ExitCode { get; init; }
    public required long ElapsedMs { get; init; }
}

public enum PowerSetting { UsbSelectiveSuspend, FastStartup }

public sealed record PowerSetParams
{
    public required PowerSetting Setting { get; init; }
    public required bool Enabled { get; init; }
}

public sealed record PowerSetOutput
{
    public required PowerSetting Setting { get; init; }
    public required bool? Before { get; init; }
    public required bool? After { get; init; }
}

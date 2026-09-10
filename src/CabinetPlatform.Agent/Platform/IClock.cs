namespace CabinetPlatform.Agent.Platform;

/// <summary>Time, injected, so that scheduling and staleness logic is testable.</summary>
public interface IClock
{
    DateTimeOffset UtcNow { get; }
}

public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

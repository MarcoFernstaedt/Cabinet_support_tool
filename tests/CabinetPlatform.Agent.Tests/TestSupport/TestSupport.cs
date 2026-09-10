using CabinetPlatform.Agent.Platform;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Tests.TestSupport;

/// <summary>A clock that does not move unless a test moves it.</summary>
internal sealed class FixedClock : IClock
{
    public FixedClock(DateTimeOffset now) => UtcNow = now;

    public DateTimeOffset UtcNow { get; set; }

    public void Advance(TimeSpan amount) => UtcNow += amount;
}

/// <summary>Wraps a plain options instance for constructors that take IOptions.</summary>
internal static class TestOptions
{
    public static IOptions<T> Create<T>(T value)
        where T : class => Options.Create(value);
}

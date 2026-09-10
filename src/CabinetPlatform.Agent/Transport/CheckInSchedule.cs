using CabinetPlatform.Agent.Configuration;

namespace CabinetPlatform.Agent.Transport;

/// <summary>
/// Works out how long to wait before the next check-in.
/// </summary>
/// <remarks>
/// Pure arithmetic with the randomness passed in, so the two properties that
/// matter can actually be asserted rather than hoped for.
/// </remarks>
public static class CheckInSchedule
{
    /// <summary>
    /// The nominal interval, spread by a small random percentage.
    /// </summary>
    /// <remarks>
    /// A clinic's cabinets are all powered from the same circuit. After an
    /// outage they boot within seconds of each other, and without jitter they
    /// would check in in lockstep forever after, delivering the whole site's
    /// payloads to the server in the same second of every interval. The spread
    /// is deliberately small: it decorrelates the fleet without making any one
    /// cabinet's cadence unpredictable to support staff.
    /// </remarks>
    /// <param name="nextDouble">
    /// A value in [0,1), normally from <see cref="Random"/>.
    /// </param>
    public static TimeSpan NextInterval(AgentOptions options, double nextDouble)
    {
        var baseSeconds = options.CheckInIntervalSeconds;
        var jitterPercent = Math.Clamp(options.CheckInJitterPercent, 0, 50);

        if (jitterPercent == 0)
        {
            return TimeSpan.FromSeconds(baseSeconds);
        }

        // Map [0,1) onto [-jitter, +jitter) so the mean interval stays the
        // configured one; a one-sided spread would slowly drift the whole fleet.
        var offsetFraction = ((nextDouble * 2.0) - 1.0) * (jitterPercent / 100.0);
        var seconds = baseSeconds * (1.0 + offsetFraction);

        // Never shorter than a second, whatever the configuration says.
        return TimeSpan.FromSeconds(Math.Max(1.0, seconds));
    }

    /// <summary>
    /// The delay after <paramref name="consecutiveFailures"/> failed attempts.
    /// </summary>
    /// <remarks>
    /// The ceiling is the important half. Unbounded growth would eventually
    /// silence a cabinet for days after a brief outage, and no growth at all
    /// would have every cabinet in the estate retrying against a server that is
    /// already struggling. The delay is jittered for the same reason the
    /// interval is: a fleet that all failed at once must not all retry at once.
    /// </remarks>
    public static TimeSpan BackoffDelay(BackoffOptions options, int consecutiveFailures, double nextDouble)
    {
        if (consecutiveFailures <= 0)
        {
            return TimeSpan.Zero;
        }

        var exponent = consecutiveFailures - 1;

        // Math.Pow on a large exponent overflows to infinity, which then
        // becomes a negative TimeSpan. The ceiling is applied in double space
        // first so that can never happen.
        var raw = options.InitialSeconds * Math.Pow(options.Multiplier, exponent);
        var capped = double.IsFinite(raw)
            ? Math.Min(raw, options.MaximumSeconds)
            : options.MaximumSeconds;

        // Full jitter across the lower half of the window: enough to spread a
        // fleet's retries without letting the delay collapse to nothing.
        var jittered = capped * (0.5 + (nextDouble * 0.5));

        return TimeSpan.FromSeconds(Math.Clamp(jittered, 1.0, options.MaximumSeconds));
    }
}

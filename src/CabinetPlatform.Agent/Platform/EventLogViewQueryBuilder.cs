using System.Globalization;
using System.Text;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Turns a server-supplied view definition into the XPath the Windows event log
/// service evaluates.
/// </summary>
/// <remarks>
/// <para>
/// This class is the whole reason a view travels as named fields rather than as
/// a query string. The server stores logs, sources, event ids, a level and a
/// window; the agent — here, and only here — composes the expression. There is
/// no path by which text a person typed becomes an XPath: the level and the
/// window are numbers, the event ids are numbers, and the source names are the
/// one string input, which is validated and quoted below.
/// </para>
/// <para>
/// A view built the other way round, with the server sending an expression,
/// would work identically on the first day and would be a remote query
/// execution channel on every day after it.
/// </para>
/// </remarks>
public static class EventLogViewQueryBuilder
{
    /// <summary>
    /// Builds the filter for one log in a view.
    /// </summary>
    /// <param name="definition">The view, as the server expanded it.</param>
    /// <param name="window">How far back to look.</param>
    public static string Build(EventLogViewDefinition definition, TimeSpan window)
    {
        var system = new List<string>(4);

        string? levels = BuildLevelClause(definition.MinimumLevel);

        if (levels is not null)
        {
            system.Add(levels);
        }

        string? providers = BuildProviderClause(definition.Sources);

        if (providers is not null)
        {
            system.Add(providers);
        }

        string? ids = BuildEventIdClause(definition.EventIds);

        if (ids is not null)
        {
            system.Add(ids);
        }

        // timediff takes milliseconds and is evaluated by the event log service
        // against the machine's own clock, which is what makes the window
        // correct on a cabinet whose time zone differs from the server's.
        long milliseconds = (long)Math.Max(window.TotalMilliseconds, 1);

        system.Add(
            $"TimeCreated[timediff(@SystemTime) <= {milliseconds.ToString(CultureInfo.InvariantCulture)}]");

        return $"*[System[{string.Join(" and ", system)}]]";
    }

    /// <summary>
    /// The level clause, as an explicit list rather than a comparison.
    /// </summary>
    /// <remarks>
    /// Windows numbers levels the opposite way round from how people think
    /// about them: Critical is 1 and Verbose is 5, so "at least Warning" is
    /// <c>Level &lt;= 3</c>, not <c>&gt;=</c>. Written out as an explicit
    /// disjunction so nobody has to hold that inversion in their head while
    /// reading it, and so level 0 — which the Security log uses for every audit
    /// record — is included deliberately rather than by accident.
    /// </remarks>
    /// <param name="minimum">The least severe level worth returning.</param>
    internal static string? BuildLevelClause(EventLogLevel minimum)
    {
        int[] windowsLevels = minimum switch
        {
            EventLogLevel.Critical => new[] { 1 },
            EventLogLevel.Error => new[] { 1, 2 },
            EventLogLevel.Warning => new[] { 1, 2, 3 },
            EventLogLevel.Information => new[] { 1, 2, 3, 4 },

            // Verbose means everything, including the unclassified level 0 the
            // Security log writes. No clause at all is both cheaper and more
            // honest than one enumerating every value.
            _ => Array.Empty<int>(),
        };

        return windowsLevels.Length == 0
            ? null
            : "(" + string.Join(" or ", windowsLevels.Select(l => $"Level={l}")) + ")";
    }

    /// <summary>
    /// The provider clause, with every name validated and quoted.
    /// </summary>
    /// <remarks>
    /// Source names are the one free-text input in a view. A name carrying a
    /// quote is dropped rather than escaped: a provider name has no business
    /// containing one, the server refuses such a name when the view is written,
    /// and dropping it here means that even a definition that somehow arrived
    /// with one cannot alter the shape of the expression.
    /// </remarks>
    /// <param name="sources">Provider names to restrict to.</param>
    internal static string? BuildProviderClause(IReadOnlyList<string> sources)
    {
        List<string> usable = sources
            .Where(IsSafeProviderName)
            .Select(s => s.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (usable.Count == 0)
        {
            return null;
        }

        var clause = new StringBuilder("Provider[");

        for (var i = 0; i < usable.Count; i++)
        {
            if (i > 0)
            {
                clause.Append(" or ");
            }

            clause.Append(CultureInfo.InvariantCulture, $"@Name='{usable[i]}'");
        }

        return clause.Append(']').ToString();
    }

    /// <summary>The event id clause.</summary>
    /// <param name="eventIds">Event ids to restrict to.</param>
    internal static string? BuildEventIdClause(IReadOnlyList<int> eventIds)
    {
        List<int> usable = eventIds.Where(id => id is >= 0 and <= 65535).Distinct().ToList();

        if (usable.Count == 0)
        {
            return null;
        }

        return "(" + string.Join(
            " or ",
            usable.Select(id => $"EventID={id.ToString(CultureInfo.InvariantCulture)}")) + ")";
    }

    /// <summary>
    /// Whether a provider name may be put into the expression.
    /// </summary>
    /// <remarks>
    /// Windows provider names are made of letters, digits, spaces and a short
    /// set of separators — <c>Microsoft-Windows-WindowsUpdateClient</c>,
    /// <c>Service Control Manager</c>, <c>.NET Runtime</c>. Anything else is
    /// not a provider name, whatever else it might be.
    /// </remarks>
    /// <param name="source">The candidate name.</param>
    internal static bool IsSafeProviderName(string? source)
    {
        if (string.IsNullOrWhiteSpace(source))
        {
            return false;
        }

        string candidate = source.Trim();

        return candidate.Length <= 255 &&
               candidate.All(c =>
                   char.IsAsciiLetterOrDigit(c) || c is ' ' or '-' or '_' or '.' or '/' or '+');
    }
}

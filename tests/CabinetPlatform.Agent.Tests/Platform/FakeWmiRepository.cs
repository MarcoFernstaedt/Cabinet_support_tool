using CabinetPlatform.Agent.Platform.Wmi;

namespace CabinetPlatform.Agent.Tests.Platform;

/// <summary>
/// A WMI repository backed by fixtures.
/// </summary>
/// <remarks>
/// Registrations are matched against the class named in the query's FROM
/// clause, not against the query text. Substring matching looks simpler but is
/// actively misleading here: "Win32_DiskDrive" is a prefix of
/// "Win32_DiskDriveToDiskPartition", so a loose match hands a collector the
/// wrong rows and fails a test that describes working code.
/// </remarks>
internal sealed class FakeWmiRepository : IWmiRepository
{
    private readonly List<(string Fragment, IReadOnlyList<WmiRecord> Rows)> _responses = new();
    private readonly List<(string Fragment, Exception Failure)> _failures = new();
    private readonly Dictionary<string, IReadOnlyList<WmiMethodResult>> _methodResults = new(StringComparer.OrdinalIgnoreCase);

    public List<string> ExecutedQueries { get; } = new();

    public FakeWmiRepository Returns(string queryFragment, params WmiRecord[] rows)
    {
        _responses.Add((queryFragment, rows));
        return this;
    }

    public FakeWmiRepository Returns(string queryFragment, IEnumerable<IReadOnlyDictionary<string, object?>> rows)
        => Returns(queryFragment, rows.Select(row => new WmiRecord(row)).ToArray());

    public FakeWmiRepository Throws(string queryFragment, Exception failure)
    {
        _failures.Add((queryFragment, failure));
        return this;
    }

    public FakeWmiRepository ReturnsMethodResult(string methodName, params WmiMethodResult[] results)
    {
        _methodResults[methodName] = results;
        return this;
    }

    public IReadOnlyList<WmiRecord> Query(string scope, string query)
    {
        ExecutedQueries.Add(query);

        var queriedClass = ExtractClassName(query);

        foreach (var (fragment, failure) in _failures)
        {
            if (Matches(fragment, queriedClass))
            {
                throw failure;
            }
        }

        foreach (var (fragment, rows) in _responses)
        {
            if (Matches(fragment, queriedClass))
            {
                return rows;
            }
        }

        return Array.Empty<WmiRecord>();
    }

    public IReadOnlyList<WmiMethodResult> InvokeMethod(
        string scope,
        string query,
        string methodName,
        IReadOnlyDictionary<string, object?>? parameters = null)
    {
        return _methodResults.TryGetValue(methodName, out var results)
            ? results
            : Array.Empty<WmiMethodResult>();
    }

    private static bool Matches(string fragment, string? queriedClass)
        => queriedClass is not null
           && string.Equals(fragment, queriedClass, StringComparison.OrdinalIgnoreCase);

    /// <summary>Reads the class name out of a WQL query's FROM clause.</summary>
    private static string? ExtractClassName(string query)
    {
        const string FromKeyword = " FROM ";

        var fromIndex = query.IndexOf(FromKeyword, StringComparison.OrdinalIgnoreCase);
        if (fromIndex < 0)
        {
            return null;
        }

        var afterFrom = query[(fromIndex + FromKeyword.Length)..].TrimStart();
        var end = afterFrom.IndexOfAny(new[] { ' ', '\t', '\r', '\n' });

        return end < 0 ? afterFrom.Trim() : afterFrom[..end].Trim();
    }

    /// <summary>Builds a row from name/value pairs.</summary>
    public static WmiRecord Row(params (string Name, object? Value)[] values)
        => new(values.ToDictionary(pair => pair.Name, pair => pair.Value, StringComparer.OrdinalIgnoreCase));
}

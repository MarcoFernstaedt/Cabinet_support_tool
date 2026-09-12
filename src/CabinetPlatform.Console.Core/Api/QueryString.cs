using System.Globalization;
using System.Text;

namespace CabinetPlatform.Console.Core.Api;

/// <summary>
/// Builds the query half of a request URL with everything escaped.
/// </summary>
/// <remarks>
/// String interpolation into a URL is how a hostname filter typed as
/// <c>Bay 3 &amp; 4</c> silently becomes two parameters. This exists so no
/// caller has to remember to escape, and so <see cref="ApiClient"/> is the only
/// file in the console that knows what a URL looks like.
/// </remarks>
internal sealed class QueryString
{
    private readonly StringBuilder _builder = new();

    /// <summary>Enums are written as names, matching the wire convention in Contracts.</summary>
    public QueryString Add(string name, Enum? value) =>
        value is null ? this : AddRaw(name, value.ToString());

    public QueryString Add(string name, string? value) =>
        string.IsNullOrWhiteSpace(value) ? this : AddRaw(name, value.Trim());

    public QueryString Add(string name, int? value) =>
        value is null ? this : AddRaw(name, value.Value.ToString(CultureInfo.InvariantCulture));

    public QueryString Add(string name, bool? value) =>
        value is null ? this : AddRaw(name, value.Value ? "true" : "false");

    public QueryString Add(string name, Guid? value) =>
        value is null ? this : AddRaw(name, value.Value.ToString("D"));

    /// <summary>
    /// Round-trip ("o") format, always. The server's windows are UTC, and a
    /// local-format timestamp would be interpreted in the server's culture — an
    /// audit query silently off by hours is worse than one that fails.
    /// </summary>
    public QueryString Add(string name, DateTimeOffset? value) =>
        value is null
            ? this
            : AddRaw(name, value.Value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture));

    private QueryString AddRaw(string name, string value)
    {
        _builder.Append(_builder.Length == 0 ? '?' : '&')
            .Append(Uri.EscapeDataString(name))
            .Append('=')
            .Append(Uri.EscapeDataString(value));

        return this;
    }

    public override string ToString() => _builder.ToString();
}

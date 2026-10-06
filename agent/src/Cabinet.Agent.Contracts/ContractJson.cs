using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace Cabinet.Agent.Contracts;

/// <summary>
/// The one JSON configuration every agent message uses. camelCase names,
/// snake_case enum values, UTC timestamps ending in Z, and unknown properties
/// refused rather than ignored.
/// </summary>
public static class ContractJson
{
    public static JsonSerializerOptions Options { get; } = Create();

    private static JsonSerializerOptions Create()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            NumberHandling = JsonNumberHandling.Strict,
            AllowTrailingCommas = false,
            ReadCommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 32,
            TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
        };
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower, allowIntegerValues: false));
        options.Converters.Add(new UtcTimestampConverter());
        options.Converters.Add(new NullableUtcTimestampConverter());
        options.MakeReadOnly();
        return options;
    }
}

/// <summary>
/// Reads and writes DateTimeOffset as UTC ISO 8601 with a trailing Z, as the
/// protocol requires. Offsets other than Z are refused on read.
/// </summary>
public sealed class UtcTimestampConverter : JsonConverter<DateTimeOffset>
{
    private const string WriteFormat = "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'";

    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        string? text = reader.GetString();
        if (text is null || !text.EndsWith('Z') ||
            !DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var value))
        {
            throw new JsonException("Timestamps must be UTC ISO 8601 ending in Z.");
        }
        return value;
    }

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.UtcDateTime.ToString(WriteFormat, CultureInfo.InvariantCulture));
}

public sealed class NullableUtcTimestampConverter : JsonConverter<DateTimeOffset?>
{
    private static readonly UtcTimestampConverter Inner = new();

    public override bool HandleNull => true;

    public override DateTimeOffset? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.Null ? null : Inner.Read(ref reader, typeof(DateTimeOffset), options);

    public override void Write(Utf8JsonWriter writer, DateTimeOffset? value, JsonSerializerOptions options)
    {
        if (value is null) writer.WriteNullValue();
        else Inner.Write(writer, value.Value, options);
    }
}

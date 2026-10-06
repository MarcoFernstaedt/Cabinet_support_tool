using System.Reflection;
using System.Text.Json;
using Json.Schema;

namespace Cabinet.Agent.Core;

/// <summary>One validation problem: where and which rule. Never the submitted value.</summary>
public sealed record SchemaIssue(string Path, string Rule);

/// <summary>
/// The shared contract schemas, compiled into this assembly. Every input is
/// checked here before any other code reads it.
/// </summary>
public sealed class ContractSchemas
{
    public const string BaseId = "https://schemas.mashura.example/cabinet-diagnostics/v1/";

    public static ContractSchemas Instance { get; } = new();

    private readonly BuildOptions _build = new() { SchemaRegistry = new SchemaRegistry() };
    private readonly Dictionary<string, JsonSchema> _byRef = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    private ContractSchemas()
    {
        Assembly assembly = typeof(ContractSchemas).Assembly;
        int loaded = 0;
        foreach (string name in assembly.GetManifestResourceNames().Order(StringComparer.Ordinal))
        {
            string normalized = name.Replace('\\', '/');
            if (!normalized.StartsWith("schemas/", StringComparison.Ordinal)) continue;
            using Stream stream = assembly.GetManifestResourceStream(name)!;
            using var reader = new StreamReader(stream);
            JsonSchema.FromText(reader.ReadToEnd(), _build, new Uri(BaseId + normalized["schemas/".Length..]));
            loaded++;
        }
        if (loaded == 0) throw new InvalidOperationException("No contract schemas are embedded in the agent.");
    }

    public static string Envelope(string name) => $"{BaseId}envelopes/{name}.schema.json";
    public static string Local(string name) => $"{BaseId}agent/{name}.schema.json";
    public static string Params(string operation) => $"{BaseId}operations/{operation}.schema.json#/$defs/params";
    public static string Output(string operation) => $"{BaseId}operations/{operation}.schema.json#/$defs/output";
    public static string CommandProperty(string property) => $"{BaseId}envelopes/command.schema.json#/properties/{property}";

    /// <summary>Validates <paramref name="instance"/> against the schema at <paramref name="schemaRef"/>.</summary>
    public IReadOnlyList<SchemaIssue> Validate(string schemaRef, JsonElement instance)
    {
        JsonSchema schema;
        EvaluationResults results;
        lock (_gate)
        {
            if (!_byRef.TryGetValue(schemaRef, out schema!))
            {
                schema = JsonSchema.FromText(
                    $$"""{"$schema":"https://json-schema.org/draft/2020-12/schema","$ref":"{{schemaRef}}"}""", _build);
                _byRef[schemaRef] = schema;
            }
            results = schema.Evaluate(instance, new EvaluationOptions { OutputFormat = OutputFormat.List });
        }
        if (results.IsValid) return Array.Empty<SchemaIssue>();
        var issues = new List<SchemaIssue>();
        foreach (EvaluationResults detail in results.Details ?? (IReadOnlyList<EvaluationResults>)Array.Empty<EvaluationResults>())
        {
            if (detail.Errors is null) continue;
            foreach (string keyword in detail.Errors.Keys)
            {
                issues.Add(new SchemaIssue(detail.InstanceLocation.ToString() is { Length: > 0 } p ? p : "/", keyword));
                if (issues.Count == 20) return issues;
            }
        }
        if (issues.Count == 0) issues.Add(new SchemaIssue("/", "schema"));
        return issues;
    }

    public bool IsValid(string schemaRef, JsonElement instance) => Validate(schemaRef, instance).Count == 0;
}

public static class ContractValues
{

    /// <summary>Whether a single string satisfies a common definition, e.g. "hardwareId". Used to drop odd values Windows reports instead of failing a whole listing.</summary>
    public static bool Is(string commonDef, string? value)
    {
        if (value is null) return false;
        return ContractSchemas.Instance.IsValid(
            $"{ContractSchemas.BaseId}common.schema.json#/$defs/{commonDef}",
            System.Text.Json.JsonSerializer.SerializeToElement(value));
    }
}

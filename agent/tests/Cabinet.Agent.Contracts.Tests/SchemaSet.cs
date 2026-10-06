using System.Text.Json;
using Json.Schema;

namespace Cabinet.Agent.Contracts.Tests;

/// <summary>
/// The shared contract schemas, loaded from contracts/schemas in this
/// repository. The same files the server validates with.
/// </summary>
public sealed class SchemaSet
{
    public const string BaseId = "https://schemas.mashura.example/cabinet-diagnostics/v1/";

    public static SchemaSet Instance { get; } = new();

    public string ContractsDir { get; }
    public string SchemaDir => Path.Combine(ContractsDir, "schemas");
    public string ExamplesDir => Path.Combine(ContractsDir, "examples");

    private readonly BuildOptions _build;
    private readonly Dictionary<string, JsonSchema> _compiled = new(StringComparer.Ordinal);

    private SchemaSet()
    {
        ContractsDir = FindContracts();
        _build = new BuildOptions { SchemaRegistry = new SchemaRegistry() };
        foreach (string file in Directory.EnumerateFiles(SchemaDir, "*.schema.json", SearchOption.AllDirectories).Order(StringComparer.Ordinal))
        {
            string relative = Path.GetRelativePath(SchemaDir, file).Replace('\\', '/');
            JsonSchema.FromText(File.ReadAllText(file), _build, new Uri(BaseId + relative));
        }
    }

    private static string FindContracts()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            string candidate = Path.Combine(dir.FullName, "contracts", "schemas", "common.schema.json");
            if (File.Exists(candidate)) return Path.Combine(dir.FullName, "contracts");
        }
        throw new InvalidOperationException("contracts/schemas not found above the test output directory.");
    }

    /// <summary>"envelopes/command" or "operations/files.list/params" to its schema URI.</summary>
    public static string IdFor(string target)
    {
        string[] parts = target.Split('/');
        return parts[0] == "operations"
            ? $"{BaseId}operations/{parts[1]}.schema.json#/$defs/{parts[2]}"
            : $"{BaseId}{parts[0]}/{parts[1]}.schema.json";
    }

    public EvaluationResults Evaluate(string schemaId, JsonElement instance)
    {
        if (!_compiled.TryGetValue(schemaId, out JsonSchema? schema))
        {
            schema = JsonSchema.FromText($$"""{"$schema":"https://json-schema.org/draft/2020-12/schema","$ref":"{{schemaId}}"}""", _build);
            _compiled[schemaId] = schema;
        }
        return schema.Evaluate(instance, new EvaluationOptions { OutputFormat = OutputFormat.List });
    }

    public bool IsValid(string schemaId, JsonElement instance) => Evaluate(schemaId, instance).IsValid;

    public JsonElement ReadSchemaFile(string relative) =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(SchemaDir, relative))).RootElement.Clone();
}

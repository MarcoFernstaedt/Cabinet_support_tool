using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cabinet.Agent.Contracts.Tests;

/// <summary>
/// Proves the agent's C# contract types and the shared JSON Schemas describe
/// the same messages (docs/spec/08-build-plan.md, milestone 0).
/// </summary>
public sealed class ContractTests
{
    private static readonly SchemaSet Schemas = SchemaSet.Instance;

    private static JsonElement Load(string target, string kind, string name) =>
        JsonDocument.Parse(File.ReadAllText(ExampleData.PathOf(target, kind, name))).RootElement.Clone();

    [Theory]
    [MemberData(nameof(ExampleData.Valid), MemberType = typeof(ExampleData))]
    public void Valid_examples_pass_the_schema(string target, string name)
    {
        EvaluationResultsAssert.Valid(Schemas.Evaluate(SchemaSet.IdFor(target), Load(target, "valid", name)), $"{target}/{name}");
    }

    [Theory]
    [MemberData(nameof(ExampleData.Invalid), MemberType = typeof(ExampleData))]
    public void Hostile_and_malformed_examples_fail_the_schema(string target, string name)
    {
        Assert.False(Schemas.IsValid(SchemaSet.IdFor(target), Load(target, "invalid", name)), $"{target}/{name} was accepted");
    }

    [Theory]
    [MemberData(nameof(ExampleData.Valid), MemberType = typeof(ExampleData))]
    public void Valid_examples_round_trip_through_the_csharp_types(string target, string name)
    {
        JsonElement original = Load(target, "valid", name);
        Type type = ExampleData.TypeFor(target);

        // Strict read: an unknown property or a missing required one throws.
        object? typed = original.Deserialize(type, ContractJson.Options);
        Assert.NotNull(typed);

        // What the agent would send must still satisfy the schema...
        JsonElement written = JsonSerializer.SerializeToElement(typed, type, ContractJson.Options);
        EvaluationResultsAssert.Valid(Schemas.Evaluate(SchemaSet.IdFor(target), written), $"{target}/{name} after C# round trip");

        // ...and carry exactly the same information (an absent optional and an explicit null are equivalent).
        Assert.True(JsonNode.DeepEquals(WithoutNulls(original), WithoutNulls(written)),
            $"{target}/{name} changed in the round trip:\n{original}\n{written}");
    }

    [Fact]
    public void The_csharp_catalog_matches_the_contract_catalog()
    {
        JsonElement catalog = Schemas.ReadSchemaFile("operations/catalog.json");
        var schemaOps = catalog.GetProperty("operations").EnumerateArray().ToDictionary(o => o.GetProperty("name").GetString()!);
        Assert.Equal(schemaOps.Keys.Order(StringComparer.Ordinal), Catalog.All.Select(e => e.Name).Order(StringComparer.Ordinal));
        foreach (CatalogEntry entry in Catalog.All)
        {
            JsonElement op = schemaOps[entry.Name];
            Assert.Equal(op.GetProperty("kind").GetString(), entry.Kind.ToString().ToLowerInvariant());
            Assert.Equal(op.GetProperty("minimumRole").GetString(), entry.MinimumRole);
            Assert.Equal(op.GetProperty("stepUp").GetBoolean(), entry.StepUp);
            Assert.Equal(op.GetProperty("expirySeconds").GetInt32(), entry.ExpirySeconds);
            Assert.Equal(op.GetProperty("rateClass").GetString(), JsonNamingPolicy.SnakeCaseLower.ConvertName(entry.RateClass.ToString()));
            Assert.Equal(op.TryGetProperty("safetyNet", out JsonElement s) && s.GetBoolean(), entry.SafetyNet);
        }
    }

    [Fact]
    public void Catalog_lookup_is_exact()
    {
        Assert.True(Catalog.TryGet("files.list", out _));
        Assert.False(Catalog.TryGet("FILES.LIST", out _));
        Assert.False(Catalog.TryGet("files.list ", out _));
        Assert.False(Catalog.TryGet("shell.run", out _));
        Assert.False(Catalog.TryGet(null, out _));
    }

    public static IEnumerable<object[]> EnumMappings() => new[]
    {
        new object[] { typeof(EventLevel), "common.schema.json", "/$defs/eventLevel/enum" },
        new object[] { typeof(CabinetRole), "common.schema.json", "/$defs/cabinetRole/enum" },
        new object[] { typeof(FirewallProfile), "common.schema.json", "/$defs/firewallProfile/enum" },
        new object[] { typeof(FirewallAction), "common.schema.json", "/$defs/firewallAction/enum" },
        new object[] { typeof(FirewallDirection), "common.schema.json", "/$defs/firewallDirection/enum" },
        new object[] { typeof(FirewallProtocol), "common.schema.json", "/$defs/firewallProtocol/enum" },
        new object[] { typeof(ResultStatus), "envelopes/result.schema.json", "/properties/status/enum" },
        new object[] { typeof(EventKind), "envelopes/event.schema.json", "/properties/kind/enum" },
        new object[] { typeof(SeverityHint), "envelopes/event.schema.json", "/properties/severityHint/enum" },
        new object[] { typeof(EnrollState), "envelopes/enroll-status.schema.json", "/properties/status/enum" },
        new object[] { typeof(NetworkTestTarget), "operations/network.test.schema.json", "/$defs/params/properties/target/enum" },
        new object[] { typeof(NetworkTestMethod), "operations/network.test.schema.json", "/$defs/params/properties/method/enum" },
        new object[] { typeof(UpdateResult), "operations/updates.status.schema.json", "/$defs/output/properties/installed/items/properties/result/enum" },
        new object[] { typeof(DriveHealth), "operations/disk.smart.schema.json", "/$defs/output/properties/drives/items/properties/health/enum" },
        new object[] { typeof(FileEntryType), "operations/files.list.schema.json", "/$defs/output/properties/entries/items/properties/type/enum" },
        new object[] { typeof(AdapterType), "operations/network.config.schema.json", "/$defs/output/properties/adapters/items/properties/type/enum" },
        new object[] { typeof(IpMode), "operations/network.setIp.schema.json", "/$defs/params/properties/mode/enum" },
        new object[] { typeof(DnsMode), "operations/network.setDns.schema.json", "/$defs/params/properties/mode/enum" },
        new object[] { typeof(RuleChange), "operations/firewall.setRule.schema.json", "/$defs/params/properties/change/enum" },
        new object[] { typeof(PackageType), "operations/package.install.schema.json", "/$defs/params/properties/packageType/enum" },
        new object[] { typeof(CheckOutcome), "operations/package.install.schema.json", "/$defs/output/properties/checks/properties/hash/enum" },
    };

    [Theory]
    [MemberData(nameof(EnumMappings))]
    public void Every_csharp_enum_matches_its_schema_enum(Type enumType, string file, string pointer)
    {
        JsonNode? node = JsonNode.Parse(Schemas.ReadSchemaFile(file).GetRawText());
        foreach (string segment in pointer.Trim('/').Split('/')) node = node![segment];
        string[] schemaValues = node!.AsArray().Select(v => v!.GetValue<string>()).Order(StringComparer.Ordinal).ToArray();
        string[] csharpValues = Enum.GetValues(enumType).Cast<object>()
            .Select(v => JsonSerializer.SerializeToElement(v, enumType, ContractJson.Options).GetString()!)
            .Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(schemaValues, csharpValues);
    }

    [Fact]
    public void Allowed_logs_and_error_codes_match_the_schema_lists()
    {
        JsonElement defs = Schemas.ReadSchemaFile("common.schema.json").GetProperty("$defs");
        string[] Values(string def) => defs.GetProperty(def).GetProperty("enum").EnumerateArray().Select(v => v.GetString()!).ToArray();
        Assert.Equal(Values("allowedLog"), Catalog.AllowedLogs);
        Assert.Equal(Values("rejectionCode"), Catalog.RejectionCodes);
        Assert.Equal(Values("failureCode"), Catalog.FailureCodes);
        Assert.DoesNotContain(Catalog.AllowedLogs, l => l.Equals("Security", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Messages_built_in_csharp_satisfy_the_schemas()
    {
        var at = new DateTimeOffset(2026, 10, 4, 19, 0, 0, TimeSpan.Zero);
        var output = new FilesListOutput
        {
            Path = "C:\\ProgramData",
            Page = 1,
            Entries = new[] { new FileEntry { Name = "Mashura", Type = FileEntryType.Directory, SizeBytes = null, ModifiedAt = at } },
            HasMore = false,
        };
        var result = new Result
        {
            CommandId = Guid.NewGuid(),
            Status = ResultStatus.Succeeded,
            StartedAt = at,
            FinishedAt = at.AddMilliseconds(1234.5),
            Output = JsonSerializer.SerializeToElement(output, ContractJson.Options),
        };
        EvaluationResultsAssert.Valid(Schemas.Evaluate(SchemaSet.IdFor("envelopes/result"), JsonSerializer.SerializeToElement(result, ContractJson.Options)), "result");
        EvaluationResultsAssert.Valid(Schemas.Evaluate(SchemaSet.IdFor("operations/files.list/output"), result.Output!.Value), "files.list output");

        var rejected = new Result
        {
            CommandId = Guid.NewGuid(), Status = ResultStatus.Rejected, StartedAt = at, FinishedAt = at,
            Error = new ResultError { Code = "replayed", Message = "This command ID was already seen." },
        };
        EvaluationResultsAssert.Valid(Schemas.Evaluate(SchemaSet.IdFor("envelopes/result"), JsonSerializer.SerializeToElement(rejected, ContractJson.Options)), "rejected result");

        var heartbeat = new Heartbeat { AgentVersion = "2.0.0", UptimeSeconds = 60, ReadOnlyMode = true };
        JsonElement hb = JsonSerializer.SerializeToElement(heartbeat, ContractJson.Options);
        EvaluationResultsAssert.Valid(Schemas.Evaluate(SchemaSet.IdFor("envelopes/heartbeat"), hb), "heartbeat");
        Assert.False(hb.TryGetProperty("clockSkewSeconds", out _), "an optional null must be omitted, not sent as null");
    }

    [Fact]
    public void Timestamps_are_written_as_utc_with_z_and_non_utc_input_is_refused()
    {
        var local = new DateTimeOffset(2026, 10, 4, 12, 0, 0, TimeSpan.FromHours(-7));
        Assert.Equal("\"2026-10-04T19:00:00Z\"", JsonSerializer.Serialize(local, ContractJson.Options));
        Assert.Equal("\"2026-10-04T19:00:00.25Z\"", JsonSerializer.Serialize(local.AddMilliseconds(250), ContractJson.Options));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<DateTimeOffset>("\"2026-10-04T12:00:00-07:00\"", ContractJson.Options));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<DateTimeOffset>("\"2026-10-04 19:00:00\"", ContractJson.Options));
    }

    [Fact]
    public void Hostile_json_is_refused_by_the_csharp_reader_too()
    {
        string valid = File.ReadAllText(ExampleData.PathOf("envelopes/command", "valid", "eventlog-query.json"));

        // Unknown property: refused, not ignored.
        string extra = valid.TrimEnd().TrimEnd('}') + ", \"runAs\": \"SYSTEM\"}";
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Command>(extra, ContractJson.Options));

        // Duplicate keys: the parse step the agent uses (JsonNode) refuses them,
        // so "last one wins" can never hide a second value from a validator.
        string duplicate = valid.TrimEnd().TrimEnd('}') + ", \"operation\": \"driver.uninstall\"}";
        Assert.ThrowsAny<Exception>(() => JsonNode.Parse(duplicate)!.AsObject().Count);

        // Excessive nesting stops at the configured depth.
        string deep = new string('[', 200) + new string(']', 200);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<JsonElement>(deep, ContractJson.Options));

        // Numbers as strings are not coerced.
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<EventlogGetParams>("{\"log\":\"System\",\"recordId\":\"5\"}", ContractJson.Options));
    }

    private static JsonNode? WithoutNulls(JsonElement element)
    {
        JsonNode? node = JsonNode.Parse(element.GetRawText());
        Strip(node);
        return node;

        static void Strip(JsonNode? n)
        {
            if (n is JsonObject obj)
            {
                foreach (string key in obj.Where(p => p.Value is null).Select(p => p.Key).ToList()) obj.Remove(key);
                foreach (var p in obj) Strip(p.Value);
            }
            else if (n is JsonArray arr)
            {
                foreach (JsonNode? item in arr) Strip(item);
            }
        }
    }
}

internal static class EvaluationResultsAssert
{
    public static void Valid(Json.Schema.EvaluationResults results, string what)
    {
        if (results.IsValid) return;
        IEnumerable<string> problems = (results.Details ?? new List<Json.Schema.EvaluationResults>())
            .Where(d => d.Errors is { Count: > 0 })
            .SelectMany(d => d.Errors!.Select(e => $"{d.InstanceLocation} ({d.EvaluationPath}): {e.Key} {e.Value}"))
            .Take(10);
        Assert.Fail($"{what} does not match its schema:\n{string.Join("\n", problems)}");
    }
}

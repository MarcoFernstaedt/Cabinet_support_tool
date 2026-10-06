namespace Cabinet.Agent.Contracts.Tests;

/// <summary>Every file under contracts/examples, as (target, kind, file).</summary>
public static class ExampleData
{
    public static IEnumerable<(string Target, string Kind, string File)> All()
    {
        string root = SchemaSet.Instance.ExamplesDir;
        foreach (string file in Directory.EnumerateFiles(root, "*.json", SearchOption.AllDirectories).Order(StringComparer.Ordinal))
        {
            string relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            string[] parts = relative.Split('/');
            string kind = parts[^2];
            string target = string.Join('/', parts[..^2]);
            yield return (target, kind, file);
        }
    }

    public static IEnumerable<object[]> Valid() =>
        All().Where(e => e.Kind == "valid").Select(e => new object[] { e.Target, Path.GetFileName(e.File) });

    public static IEnumerable<object[]> Invalid() =>
        All().Where(e => e.Kind == "invalid").Select(e => new object[] { e.Target, Path.GetFileName(e.File) });

    public static string PathOf(string target, string kind, string name) =>
        Path.Combine(SchemaSet.Instance.ExamplesDir, target, kind, name);

    /// <summary>The C# type each example target deserializes into.</summary>
    public static Type TypeFor(string target)
    {
        string[] parts = target.Split('/');
        if (parts[0] == "operations")
        {
            Assert.True(Catalog.TryGet(parts[1], out CatalogEntry entry), $"{parts[1]} is not in the C# catalog");
            return parts[2] == "params" ? entry.ParamsType : entry.OutputType;
        }
        return parts[1] switch
        {
            "command" => typeof(Command),
            "result" => typeof(Result),
            "event" => typeof(AgentEvent),
            "event-batch" => typeof(EventBatch),
            "heartbeat" => typeof(Heartbeat),
            "server-ack" => typeof(ServerAck),
            "commands-response" => typeof(CommandsResponse),
            "enroll-request" => typeof(EnrollRequest),
            "enroll-response" => typeof(EnrollResponse),
            "enroll-status" => typeof(EnrollStatus),
            "renew-request" => typeof(RenewRequest),
            "renew-response" => typeof(RenewResponse),
            "agent-config" => typeof(AgentConfig),
            "broker-request" => typeof(BrokerRequest),
            "broker-response" => typeof(BrokerResponse),
            _ => throw new InvalidOperationException($"No C# type for {target}"),
        };
    }
}

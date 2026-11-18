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

    /// <summary>Valid examples of the contracts the agent itself reads or writes (the console's request bodies and the diagnostic modules are the server's alone).</summary>
    public static IEnumerable<object[]> ValidForAgent() =>
        All().Where(e => e.Kind == "valid" && !e.Target.StartsWith("console/", StringComparison.Ordinal) && !e.Target.StartsWith("diagnostics/", StringComparison.Ordinal))
            .Select(e => new object[] { e.Target, Path.GetFileName(e.File) });

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
            "session-control" => typeof(SessionControl),
            "session-frame" => typeof(SessionDiagnosticFrame),
            "ssh-transport-data" => typeof(SshTransportData),
            "ssh-transport-claim" => typeof(SshTransportClaim),
            "command" => typeof(Command),
            "result" => typeof(Result),
            "event" => typeof(AgentEvent),
            "event-batch" => typeof(EventBatch),
            "config-upload" => typeof(ConfigUpload),
            "heartbeat" => typeof(Heartbeat),
            "server-ack" => typeof(ServerAck),
            "heartbeat-response" => typeof(HeartbeatResponse),
            "commands-response" => typeof(CommandsResponse),
            "enroll-request" => typeof(EnrollRequest),
            "enroll-response" => typeof(EnrollResponse),
            "enroll-status" => typeof(EnrollStatus),
            "renew-request" => typeof(RenewRequest),
            "renew-response" => typeof(RenewResponse),
            "agent-config" => typeof(AgentConfig),
            "broker-request" => typeof(BrokerRequest),
            "broker-response" => typeof(BrokerResponse),
            "safety-net-status" => typeof(SafetyNetStatus),
            "trusted-publishers" => typeof(TrustedPublishers),
            "upgrade-manifest" => typeof(UpgradeManifest),
            "upgrade-signature" => typeof(UpgradeSignature),
            "upgrade-keys" => typeof(UpgradeKeys),
            "upgrade-journal" => typeof(UpgradeJournal),
            "check-in" => typeof(CheckIn),
            "update-response" => typeof(UpdateResponse),
            "upgrade-status" => typeof(UpgradeStatus),
            "service-watch" => typeof(ServiceWatch),
            "approved-list" => typeof(ApprovedListDocument),
            "approved-list-signature" => typeof(ApprovedListSignature),
            "approved-list-keys" => typeof(ApprovedListKeys),
            _ => throw new InvalidOperationException($"No C# type for {target}"),
        };
    }
}

using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core;

/// <summary>Reads the local protected configuration, validated against agent/agent-config.schema.json.</summary>
public static class AgentConfigLoader
{
    public const int MaxBytes = 64 * 1024;

    public static AgentConfig Load(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new AgentConfigException("The agent configuration file does not exist.");
        if (info.Length > MaxBytes) throw new AgentConfigException("The agent configuration file is too large.");
        return Parse(File.ReadAllBytes(path));
    }

    public static AgentConfig Parse(byte[] utf8)
    {
        if (!StrictJson.TryParse(utf8, MaxBytes, out JsonDocument? doc))
            throw new AgentConfigException("The agent configuration is not valid JSON.");
        using (doc)
        {
            IReadOnlyList<SchemaIssue> issues = ContractSchemas.Instance.Validate(ContractSchemas.Local("agent-config"), doc!.RootElement);
            if (issues.Count > 0)
                throw new AgentConfigException("The agent configuration does not match its schema: " +
                    string.Join(", ", issues.Select(i => $"{i.Path} ({i.Rule})")));
            return doc.RootElement.Deserialize<AgentConfig>(ContractJson.Options)!;
        }
    }
}

public sealed class AgentConfigException(string message) : Exception(message);

namespace Cabinet.Agent.Core.Tests;

/// <summary>A clock the test moves by hand.</summary>
public sealed class ManualClock(DateTimeOffset start) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = start;
    public override DateTimeOffset GetUtcNow() => Now;
    public void Advance(TimeSpan by) => Now += by;
}

public static class Fixtures
{
    public static readonly DateTimeOffset Start = new(2026, 10, 6, 12, 0, 0, TimeSpan.Zero);
    public static readonly Guid Cabinet = Guid.Parse("9b2d7c1e-5a4f-4e3b-8c2d-1f0e9a8b7c6d");
    public static readonly Guid Person = Guid.Parse("4c1b2a3d-9e8f-4a7b-b6c5-d4e3f2a1b0c9");

    public static AgentConfig Config(bool readOnly = false, int[]? ports = null, string? sync = null, string? platform = null, string[]? scanner = null) => new()
    {
        CabinetId = Cabinet, ReadOnlyMode = readOnly, CabinetRole = null,
        Scanner = new ScannerConfig { HardwareIds = scanner ?? Array.Empty<string>() },
        SyncCabinet = new SyncCabinetConfig { Address = sync },
        PlatformServer = new PlatformServerConfig { Host = platform },
        AllowedTcpPorts = ports ?? Array.Empty<int>(), LocalHarness = false,
    };

    public static string Time(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");

    /// <summary>A valid command as a mutable JSON object.</summary>
    public static JsonObject Command(string operation = "system.info", JsonObject? parameters = null, DateTimeOffset? issued = null, int lifetimeSeconds = 60, Guid? id = null, Guid? cabinet = null)
    {
        DateTimeOffset at = issued ?? Start;
        return new JsonObject
        {
            ["commandId"] = (id ?? Guid.NewGuid()).ToString(),
            ["cabinetId"] = (cabinet ?? Cabinet).ToString(),
            ["operation"] = operation,
            ["params"] = parameters ?? new JsonObject(),
            ["issuedBy"] = Person.ToString(),
            ["issuedAt"] = Time(at),
            ["expiresAt"] = Time(at.AddSeconds(lifetimeSeconds)),
        };
    }

    public static byte[] Bytes(JsonNode node) => System.Text.Encoding.UTF8.GetBytes(node.ToJsonString());
    public static byte[] Bytes(string text) => System.Text.Encoding.UTF8.GetBytes(text);

    public static string ContractsDir()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "contracts", "schemas", "common.schema.json"))) return Path.Combine(dir.FullName, "contracts");
        throw new InvalidOperationException("contracts not found");
    }
}

public sealed class TempDir : IDisposable
{
    public string Path { get; } = Directory.CreateTempSubdirectory("cabinet-agent-test-").FullName;
    public string File(string name) => System.IO.Path.Combine(Path, name);
    public void Dispose() { try { Directory.Delete(Path, true); } catch (IOException) { } }
}

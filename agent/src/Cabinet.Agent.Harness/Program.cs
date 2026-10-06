using System.Runtime.Versioning;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Windows;

[assembly: SupportedOSPlatform("windows")]

namespace Cabinet.Agent.Harness;

/// <summary>
/// The local test harness. Commands still pass the six checks: a harness
/// command for another cabinet, an expired one or a repeated one is refused
/// exactly as a server command would be. There is no option to skip a check.
/// </summary>
public static class Program
{
    private const string Usage = """
        cabinet-harness: run agent commands from a file, without a server.

          sample   --config <agent-config.json> --out <commands.json>
                   Writes one fresh command for every read operation.
          make     --config <agent-config.json> --operation <name> [--params <json>] [--out <commands.json>]
                   Writes one fresh command (valid for the operation's full lifetime).
          run      --config <agent-config.json> --commands <commands.json> [--out <results.json>]
                   Runs the commands in this process, with its own replay store and limits.
                   Broker reads run in-process too, so run it as an administrator.
          drop     --commands <commands.json> [--wait <seconds>]
                   Hands the file to the installed services' inbox (localHarness must be on)
                   and prints the results, so commands travel through the real broker pipe.
          probe-broker
                   Tries to open the installed broker's pipe as the current account.
                   Exits 0 when Windows refuses (the expected result), 1 if it connects.
        """;

    public static async Task<int> Main(string[] args)
    {
        if (args.Length == 0) { Console.WriteLine(Usage); return 2; }
        var options = Options(args.Skip(1).ToArray());
        try
        {
            return args[0] switch
            {
                "sample" => Sample(options),
                "make" => Make(options),
                "run" => await RunAsync(options),
                "drop" => await DropAsync(options),
                "probe-broker" => await ProbeAsync(),
                _ => Fail(Usage),
            };
        }
        catch (Exception e) when (e is CommandFileException or AgentConfigException or ArgumentException or IOException or JsonException)
        {
            return Fail(e.Message);
        }
    }

    private static Dictionary<string, string> Options(string[] args)
    {
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int i = 0; i + 1 < args.Length; i += 2)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal)) throw new ArgumentException($"Unexpected argument {args[i]}.");
            options[args[i][2..]] = args[i + 1];
        }
        return options;
    }

    private static string Required(Dictionary<string, string> options, string name) =>
        options.TryGetValue(name, out string? value) ? value : throw new ArgumentException($"--{name} is required.\n\n{Usage}");

    private static int Fail(string message) { Console.Error.WriteLine(message); return 2; }

    private static void Output(Dictionary<string, string> options, byte[] bytes)
    {
        if (options.TryGetValue("out", out string? path)) { File.WriteAllBytes(path, bytes); Console.WriteLine($"Wrote {path}"); }
        else Console.WriteLine(System.Text.Encoding.UTF8.GetString(bytes));
    }

    private static byte[] Serialize(IEnumerable<Command> commands) =>
        JsonSerializer.SerializeToUtf8Bytes(commands, new JsonSerializerOptions(ContractJson.Options) { WriteIndented = true });

    private static int Sample(Dictionary<string, string> options)
    {
        AgentConfig config = AgentConfigLoader.Load(Required(options, "config"));
        Output(options, Serialize(CommandFile.EveryRead(config, DateTimeOffset.UtcNow)));
        return 0;
    }

    private static int Make(Dictionary<string, string> options)
    {
        AgentConfig config = AgentConfigLoader.Load(Required(options, "config"));
        using JsonDocument parameters = JsonDocument.Parse(options.GetValueOrDefault("params", "{}"));
        Output(options, Serialize(new[] { CommandFile.Make(config, Required(options, "operation"), parameters.RootElement.Clone(), DateTimeOffset.UtcNow) }));
        return 0;
    }

    private static async Task<int> RunAsync(Dictionary<string, string> options)
    {
        AgentConfig config = AgentConfigLoader.Load(Required(options, "config"));
        byte[] file = await File.ReadAllBytesAsync(Required(options, "commands"));
        TimeProvider clock = TimeProvider.System;
        string state = Directory.CreateTempSubdirectory("cabinet-harness-").FullName;
        BrokerClient broker = InProcessBroker.Client(new BrokerRequestHandler(BrokerReadOperations.Registry()));
        var processor = new CommandProcessor(
            new CommandValidator(config, new ReplayStore(Path.Combine(state, "replay.log"), clock), new RateLimiter(Path.Combine(state, "writes.log"), clock), clock),
            NetworkOperations.Registry(config, broker, clock), clock);
        var entries = await CommandFile.RunAsync(file, processor, CancellationToken.None);
        Output(options, CommandFile.Write(entries));
        Summarize(entries);
        return entries.All(e => e.Result?.Status == ResultStatus.Succeeded) ? 0 : 1;
    }

    private static async Task<int> DropAsync(Dictionary<string, string> options)
    {
        string source = Required(options, "commands");
        int wait = int.Parse(options.GetValueOrDefault("wait", "180"), System.Globalization.CultureInfo.InvariantCulture);
        string name = $"harness-{Guid.NewGuid():N}";
        string temp = Path.Combine(AgentPaths.HarnessInbox, name + ".tmp");
        File.Copy(source, temp);
        File.Move(temp, Path.Combine(AgentPaths.HarnessInbox, name + ".json"));
        string result = Path.Combine(AgentPaths.HarnessOutbox, name + ".result.json");
        for (var started = DateTime.UtcNow; DateTime.UtcNow - started < TimeSpan.FromSeconds(wait); await Task.Delay(1000))
        {
            if (!File.Exists(result)) continue;
            await Task.Delay(500);
            byte[] bytes = await File.ReadAllBytesAsync(result);
            File.Delete(result);
            Output(options, bytes);
            using JsonDocument doc = JsonDocument.Parse(bytes);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return 1;
            return doc.RootElement.EnumerateArray().All(e => e.TryGetProperty("result", out var r) && r.GetProperty("status").GetString() == "succeeded") ? 0 : 1;
        }
        return Fail("No result arrived. Is the network service running with localHarness turned on?");
    }

    private static async Task<int> ProbeAsync()
    {
        try
        {
            await using Stream pipe = await BrokerPipeClient.ConnectAsync(BrokerFraming.PipeName, CancellationToken.None);
            Console.WriteLine("FAIL: this account could open the broker pipe.");
            return 1;
        }
        catch (UnauthorizedAccessException)
        {
            Console.WriteLine("OK: Windows refused this account access to the broker pipe.");
            return 0;
        }
        catch (TimeoutException)
        {
            return Fail("The broker pipe does not exist. Is the broker service running?");
        }
    }

    private static void Summarize(IReadOnlyList<CommandFile.Entry> entries)
    {
        Console.Error.WriteLine();
        foreach (var e in entries)
            Console.Error.WriteLine(e.Result is { } r
                ? $"  #{e.Index,-3} {r.Status.ToString().ToLowerInvariant(),-10} {(r.Error is null ? "" : $"{r.Error.Code}: {r.Error.Message}")}"
                : $"  #{e.Index,-3} dropped    {e.Dropped}");
    }
}

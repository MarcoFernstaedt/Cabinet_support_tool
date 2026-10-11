using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core;

/// <summary>
/// The local test harness's input: a JSON array of command envelopes in a
/// file (docs/spec/08-build-plan.md milestone 1). Each command goes through
/// exactly the same six checks as a command from the server; the file is only
/// a different way to deliver it.
/// </summary>
public static class CommandFile
{
    public const int MaxBytes = 4 * 1024 * 1024;
    public const int MaxCommands = 100;

    /// <summary>One line of the harness output: the result, or why a command could not be addressed.</summary>
    public sealed record Entry(int Index, Result? Result, string? Dropped);

    public static async Task<IReadOnlyList<Entry>> RunAsync(byte[] file, CommandProcessor processor, CancellationToken token)
    {
        if (!StrictJson.TryParse(file, MaxBytes, out JsonDocument? doc))
            throw new CommandFileException("The commands file is not valid JSON, is larger than 4 MB, or repeats a property name.");
        using (doc)
        {
            if (doc!.RootElement.ValueKind != JsonValueKind.Array)
                throw new CommandFileException("The commands file must be a JSON array of commands.");
            if (doc.RootElement.GetArrayLength() > MaxCommands)
                throw new CommandFileException($"The commands file may hold at most {MaxCommands} commands.");
            var entries = new List<Entry>();
            int index = 0;
            foreach (JsonElement command in doc.RootElement.EnumerateArray())
            {
                token.ThrowIfCancellationRequested();
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(command);
                var (result, dropped) = await processor.ProcessAsync(bytes, token).ConfigureAwait(false);
                entries.Add(new Entry(index++, result, dropped));
            }
            return entries;
        }
    }

    /// <summary>The output file: one JSON object per command, results exactly as they would go to the server.</summary>
    public static byte[] Write(IReadOnlyList<Entry> entries)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true }))
        {
            writer.WriteStartArray();
            foreach (Entry e in entries)
            {
                writer.WriteStartObject();
                writer.WriteNumber("index", e.Index);
                if (e.Result is not null)
                {
                    writer.WritePropertyName("result");
                    JsonSerializer.Serialize(writer, e.Result, ContractJson.Options);
                }
                else writer.WriteString("dropped", e.Dropped);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        return stream.ToArray();
    }

    /// <summary>A fresh, valid command for this cabinet, with the longest lifetime the operation allows.</summary>
    public static Command Make(AgentConfig config, string operation, JsonElement parameters, DateTimeOffset now)
    {
        if (!Catalog.TryGet(operation, out CatalogEntry entry))
            throw new CommandFileException("That operation is not in the catalog.");
        if (!ContractSchemas.Instance.IsValid(ContractSchemas.Params(operation), parameters))
            throw new CommandFileException("Those parameters do not match the operation's schema.");
        if (config.CabinetId is not Guid cabinetId)
            throw new CommandFileException("This agent has no cabinet ID yet: enroll it, or set cabinetId in the configuration for local testing.");
        DateTimeOffset issued = new(now.Year, now.Month, now.Day, now.Hour, now.Minute, now.Second, TimeSpan.Zero);
        return new Command
        {
            CommandId = Guid.NewGuid(), CabinetId = cabinetId, Operation = operation, Params = parameters,
            IssuedBy = Guid.Empty, IssuedAt = issued, ExpiresAt = issued.AddSeconds(entry.ExpirySeconds),
        };
    }

    /// <summary>One command for every read operation, with representative parameters.</summary>
    public static IReadOnlyList<Command> EveryRead(AgentConfig config, DateTimeOffset now)
    {
        var parameters = new Dictionary<string, object>
        {
            [Catalog.EventlogQuery] = new { log = "System", levels = new[] { "critical", "error", "warning" }, pageSize = 20 },
            [Catalog.EventlogGet] = new { log = "System", recordId = 1 },
            [Catalog.DevicesList] = new { problemsOnly = false },
            [Catalog.FilesList] = new { path = "C:\\ProgramData", pageSize = 50 },
            [Catalog.NetworkTest] = new { target = "gateway", method = "ping" },
            [Catalog.NetworkTrace] = new { target = "gateway" },
        };
        return Catalog.All.Where(e => e.Kind == OperationKind.Read)
            .Select(e => Make(config, e.Name, JsonSerializer.SerializeToElement(parameters.GetValueOrDefault(e.Name, new { })), now))
            .ToList();
    }
}

public sealed class CommandFileException(string message) : Exception(message);

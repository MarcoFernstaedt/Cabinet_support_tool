using System.Diagnostics;
using System.Text;
using System.Text.Json;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

public interface IHistoricalProcessProbe
{
    Task<HistoricalProcessEvidenceResult> ReadAsync(CancellationToken cancellationToken);
}

/// <summary>Killable same-binary boundary for synchronous Event Log calls.</summary>
public sealed class HistoricalProcessProbe : IHistoricalProcessProbe
{
    public Task<HistoricalProcessEvidenceResult> ReadAsync(CancellationToken cancellationToken)
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Native probe unavailable.");
        var start = WerMetadataProcessProbe.CreateStartInfo(executable,
            Path.Combine(AppContext.BaseDirectory, "CabinetPlatform.Agent.dll"));
        start.ArgumentList[start.ArgumentList.Count - 1] = "--historical-process-probe";
        return ReadProcessAsync(start, cancellationToken, TimeSpan.FromSeconds(5));
    }

    internal static async Task<HistoricalProcessEvidenceResult> ReadProcessAsync(ProcessStartInfo start,
        CancellationToken token, TimeSpan budget, Action<int>? onStarted = null)
    {
        using var process = new Process { StartInfo = start };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(budget);
        bool started = false;
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Native probe unavailable.");
            started = true;
            onStarted?.Invoke(process.Id);
            process.StandardInput.Close();
            var drain = process.StandardError.BaseStream.CopyToAsync(Stream.Null, deadline.Token);
            using var output = new MemoryStream();
            var buffer = new byte[2048];
            int n;
            while ((n = await process.StandardOutput.BaseStream.ReadAsync(buffer, deadline.Token).ConfigureAwait(false)) != 0)
            {
                if (output.Length + n > 16384) throw new InvalidDataException("Native probe output too large.");
                output.Write(buffer, 0, n);
            }
            await process.WaitForExitAsync(deadline.Token).ConfigureAwait(false);
            await drain.ConfigureAwait(false);
            if (process.ExitCode != 0) throw new InvalidDataException("Native probe unavailable.");
            return ParseStrict(Encoding.UTF8.GetString(output.ToArray()));
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested && deadline.IsCancellationRequested)
        { throw new TimeoutException("Native probe timed out."); }
        finally
        {
            if (started && !process.HasExited)
            {
                try { process.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) when (process.HasExited) { }
                await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
            }
        }
    }

    internal static HistoricalProcessEvidenceResult ParseStrict(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            Require(root, "version", "observedUtc", "windowStartUtc", "status", "auditCoverageVerified", "truncated", "events");
            if (root.GetProperty("version").GetInt32() != 1 ||
                !root.GetProperty("observedUtc").TryGetDateTimeOffset(out var now) || now.Offset != TimeSpan.Zero ||
                !root.GetProperty("windowStartUtc").TryGetDateTimeOffset(out var since) || since != now.AddDays(-1) ||
                root.GetProperty("status").GetString() is not ("Read" or "Partial" or "Denied" or "Unavailable") ||
                root.GetProperty("auditCoverageVerified").ValueKind != JsonValueKind.False ||
                root.GetProperty("truncated").ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new InvalidDataException();
            var events = root.GetProperty("events");
            if (events.ValueKind != JsonValueKind.Array || events.GetArrayLength() > 64) throw new InvalidDataException();
            foreach (var row in events.EnumerateArray())
            {
                Require(row, "occurredUtc", "kind", "processId", "recordId");
                if (!row.GetProperty("occurredUtc").TryGetDateTimeOffset(out var time) || time.Offset != TimeSpan.Zero ||
                    time < since || time > now || row.GetProperty("kind").GetString() is not ("Start" or "Exit") ||
                    !row.GetProperty("processId").TryGetUInt32(out var pid) || pid == 0 ||
                    (row.GetProperty("recordId").ValueKind != JsonValueKind.Null &&
                     (!row.GetProperty("recordId").TryGetInt64(out var id) || id <= 0))) throw new InvalidDataException();
            }
            return JsonSerializer.Deserialize<HistoricalProcessEvidenceResult>(text, AgentJson.SerializerOptions)!;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentOutOfRangeException)
        { throw new InvalidDataException("Invalid native probe result."); }
    }
    private static void Require(JsonElement element, params string[] fields)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.EnumerateObject().Select(p => p.Name).SequenceEqual(fields))
            throw new InvalidDataException("Invalid native probe result.");
    }
}

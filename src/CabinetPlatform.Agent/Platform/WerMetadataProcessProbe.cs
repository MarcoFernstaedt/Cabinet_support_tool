using System.Diagnostics;
using System.Text.Json;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Isolates synchronous WER calls from the long-running service process.</summary>
public interface IWerResultProbe
{
    Task<WerMetadataResult> ReadAsync(CancellationToken cancellationToken);
}

public sealed class WerMetadataProcessProbe : IWerResultProbe
{
    private const int MaxOutputBytes = 32768;
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(3);

    public async Task<WerMetadataResult> ReadAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var assembly = typeof(GetWerMetadataExecutor).Assembly.Location;
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("WER probe host unavailable.");
        return await ReadProcessAsync(CreateStartInfo(executable, assembly), cancellationToken, Deadline).ConfigureAwait(false);
    }

    internal static ProcessStartInfo CreateStartInfo(string executable, string assembly)
    {
        if ((!string.IsNullOrEmpty(assembly) && !Path.IsPathFullyQualified(assembly)) ||
            !Path.IsPathFullyQualified(executable))
            throw new InvalidOperationException("WER probe host unavailable.");
        var dotnetHost = Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase);
        if (dotnetHost && string.IsNullOrEmpty(assembly))
            throw new InvalidOperationException("WER probe assembly unavailable.");
        var directory = string.IsNullOrEmpty(assembly) ? Path.GetDirectoryName(executable)! : Path.GetDirectoryName(assembly)!;
        if (!dotnetHost && !Path.GetFullPath(executable).Equals(
                Path.Combine(directory, "CabinetPlatform.Agent.exe"), StringComparison.OrdinalIgnoreCase)
            && !Path.GetFullPath(executable).Equals(
                Path.Combine(directory, "CabinetPlatform.Agent"), StringComparison.Ordinal))
            throw new InvalidOperationException("WER probe host identity mismatch.");
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            WorkingDirectory = directory
        };
        // Only a fixed command. No report key, credential, action operand, or user-supplied path.
        if (dotnetHost) start.ArgumentList.Add(assembly);
        start.ArgumentList.Add("--wer-metadata-probe");
        start.Environment.Clear();
        // Windows runtime and framework-dependent host resolution need these system paths.
        foreach (var name in new[] { "SystemRoot", "WINDIR" })
            if (Environment.GetEnvironmentVariable(name) is { Length: > 0 } value)
                start.Environment[name] = value;
        return start;
    }

    // The test seam exercises the identical process lifetime path with a harmless hanging child.
    internal static async Task<WerMetadataResult> ReadProcessAsync(ProcessStartInfo start,
        CancellationToken cancellationToken, TimeSpan budget, Action<int>? onStarted = null)
    {
        using var process = new Process { StartInfo = start };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(budget);
        bool started = false;
        try
        {
            if (!process.Start()) throw new InvalidOperationException("WER probe failed to start.");
            started = true;
            onStarted?.Invoke(process.Id);
            process.StandardInput.Close();
            var errorDrain = process.StandardError.BaseStream.CopyToAsync(Stream.Null, deadline.Token);
            var outputTask = ReadBoundedAsync(process.StandardOutput.BaseStream, deadline.Token);
            var output = await outputTask.ConfigureAwait(false);
            await process.WaitForExitAsync(deadline.Token).ConfigureAwait(false);
            await errorDrain.ConfigureAwait(false);
            if (process.ExitCode != 0) throw new InvalidDataException("WER probe unavailable.");
            return ParseStrict(output);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            throw new TimeoutException("WER probe deadline exceeded.");
        }
        finally
        {
            if (started && !process.HasExited)
            {
                try { process.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) when (process.HasExited) { }
                // Never abandon an unreaped native worker. Kill may throw only when it already exited.
                await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
            }
        }
    }

    private static async Task<string> ReadBoundedAsync(Stream stream, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[2048];
        int count;
        while ((count = await stream.ReadAsync(chunk, ct).ConfigureAwait(false)) != 0)
        {
            if (buffer.Length + count > MaxOutputBytes) throw new InvalidDataException("WER probe output limit exceeded.");
            buffer.Write(chunk, 0, count);
        }
        return System.Text.Encoding.UTF8.GetString(buffer.ToArray());
    }

    internal static WerMetadataResult ParseStrict(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            RequireFields(root, "version", "observedUtc", "stores", "reports");
            if (root.GetProperty("version").GetInt32() != 1 ||
                !root.GetProperty("observedUtc").TryGetDateTimeOffset(out var observed) ||
                observed.Offset != TimeSpan.Zero) throw new InvalidDataException();
            var stores = root.GetProperty("stores");
            if (stores.ValueKind != JsonValueKind.Array || stores.GetArrayLength() != 2) throw new InvalidDataException();
            int index = 0;
            foreach (var store in stores.EnumerateArray())
            {
                RequireFields(store, "store", "status", "truncated");
                if (store.GetProperty("store").GetString() != (index++ == 0 ? "MachineQueue" : "MachineArchive") ||
                    store.GetProperty("status").GetString() is not ("Read" or "Partial" or "Denied" or "Unavailable") ||
                    store.GetProperty("truncated").ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    throw new InvalidDataException();
            }
            var reports = root.GetProperty("reports");
            if (reports.ValueKind != JsonValueKind.Array || reports.GetArrayLength() > 40) throw new InvalidDataException();
            var ids = new HashSet<Guid>();
            foreach (var report in reports.EnumerateArray())
            {
                RequireFields(report, "reportId", "createdUtc", "eventType", "store");
                if (!report.GetProperty("reportId").TryGetGuid(out var id) || id == Guid.Empty || !ids.Add(id) ||
                    !report.GetProperty("createdUtc").TryGetDateTimeOffset(out var created) ||
                    created.Offset != TimeSpan.Zero || created > observed || created < observed.AddDays(-7) ||
                    report.GetProperty("eventType").GetString() is not ("APPCRASH" or "BEX" or "BEX64" or "CLR20r3" or "MoAppCrash" or "AppHangB1") ||
                    report.GetProperty("store").GetString() is not ("MachineQueue" or "MachineArchive"))
                    throw new InvalidDataException();
            }
            return JsonSerializer.Deserialize<WerMetadataResult>(text, AgentJson.SerializerOptions)
                ?? throw new InvalidDataException();
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentOutOfRangeException)
        {
            throw new InvalidDataException("Invalid WER probe result.");
        }
    }

    private static void RequireFields(JsonElement element, params string[] names)
    {
        if (element.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        var actual = element.EnumerateObject().Select(p => p.Name).ToArray();
        if (actual.Length != names.Length || !actual.SequenceEqual(names)) throw new InvalidDataException();
    }
}

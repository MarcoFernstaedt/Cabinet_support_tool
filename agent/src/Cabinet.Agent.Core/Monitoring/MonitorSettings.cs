using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>
/// The monitors' settings that come from the console (today the scanner's hardware IDs).
/// The server sends them with every heartbeat answer; they are kept on disk so the watchers
/// still know what to look for while the server is unreachable. Data only: nothing here
/// can start an operation.
/// </summary>
public sealed class MonitorSettings
{
    private readonly string? _file;
    private readonly object _gate = new();
    private IReadOnlyList<string>? _scannerIds;

    public MonitorSettings(string? file, IReadOnlyList<string>? fallbackScannerIds = null)
    {
        _file = file;
        FallbackScannerIds = fallbackScannerIds is { Count: > 0 } ? fallbackScannerIds : null;
        if (file is null || !File.Exists(file)) return;
        try
        {
            if (!StrictJson.TryParse(File.ReadAllBytes(file), 64 * 1024, out JsonDocument? doc)) return;
            using (doc)
                if (ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("heartbeat-response"), doc!.RootElement))
                    _scannerIds = doc.RootElement.Deserialize<HeartbeatResponse>(ContractJson.Options)!.Scanner.HardwareIds;
        }
        catch (IOException) { }
    }

    /// <summary>From the cabinet's local configuration file, used only until the console has sent its own.</summary>
    public IReadOnlyList<string>? FallbackScannerIds { get; }

    public IReadOnlyList<string>? ScannerHardwareIds { get { lock (_gate) return _scannerIds ?? FallbackScannerIds; } }

    public event Action? Changed;

    public void Apply(HeartbeatResponse answer)
    {
        bool changed;
        lock (_gate)
        {
            changed = !Same(_scannerIds, answer.Scanner.HardwareIds);
            _scannerIds = answer.Scanner.HardwareIds;
            if (changed && _file is not null) AtomicFile.Write(_file, JsonSerializer.Serialize(answer, ContractJson.Options));
        }
        if (changed) Changed?.Invoke();
    }

    private static bool Same(IReadOnlyList<string>? a, IReadOnlyList<string>? b) =>
        a is null ? b is null : b is not null && a.SequenceEqual(b, StringComparer.OrdinalIgnoreCase);
}

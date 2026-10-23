using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>
/// The monitors' settings that come from the console (the scanner's hardware IDs, the services the broker keeps running,
/// and the programs the cabinet may be asked to start, stop or restart).
/// The server sends them with every heartbeat answer; they are kept on disk so the watchers
/// still know what to look for while the server is unreachable, and so the broker can hold the
/// approved list without touching the network. Data only: nothing here can start an operation.
/// </summary>
public sealed class MonitorSettings
{
    private readonly string? _file;
    private readonly object _gate = new();
    private IReadOnlyList<string>? _scannerIds;
    private IReadOnlyList<string> _watched = [];
    private IReadOnlyList<ApprovedAppEntry> _approved = [];

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
                {
                    var saved = doc.RootElement.Deserialize<HeartbeatResponse>(ContractJson.Options)!;
                    _scannerIds = saved.Scanner.HardwareIds;
                    _watched = saved.WatchedServices?.Names ?? [];
                    _approved = saved.ApprovedApps?.Entries ?? [];
                }
        }
        catch (IOException) { }
    }

    /// <summary>From the cabinet's local configuration file, used only until the console has sent its own.</summary>
    public IReadOnlyList<string>? FallbackScannerIds { get; }

    public IReadOnlyList<string>? ScannerHardwareIds { get { lock (_gate) return _scannerIds ?? FallbackScannerIds; } }

    /// <summary>The services the broker keeps running (milestone 10): from the console, kept on disk like the scanner IDs.</summary>
    public IReadOnlyList<string> WatchedServices { get { lock (_gate) return _watched; } }

    /// <summary>
    /// The programs this cabinet may be asked to start, stop or restart (milestone 10): the console's list, kept on disk
    /// like the watched services and read from there by the broker, which never touches the network. The cabinet acts on
    /// nothing else, so a list that is empty — or one the server did not send at all — means it controls nothing.
    /// </summary>
    public IReadOnlyList<ApprovedAppEntry> ApprovedApps { get { lock (_gate) return _approved; } }

    public event Action? Changed;

    public void Apply(HeartbeatResponse answer)
    {
        bool changed;
        lock (_gate)
        {
            changed = !Same(_scannerIds, answer.Scanner.HardwareIds);
            _scannerIds = answer.Scanner.HardwareIds;
            // A server from before milestone 10 sends no list: the last one is kept rather than emptied.
            bool watchChanged = answer.WatchedServices is { } w && !Same(_watched, w.Names);
            if (answer.WatchedServices is { } list) _watched = list.Names;
            // The approved list is not the watched list: the contract is plain that an answer carrying no approved list
            // leaves the agent with an empty one, so an older or broken server leaves this cabinet touching nothing. The
            // empty list is written to disk like any other, so the broker never acts on a list the server stopped sending.
            bool appsChanged = !SameApproved(_approved, answer.ApprovedApps?.Entries ?? []);
            _approved = answer.ApprovedApps?.Entries ?? [];
            if ((changed || watchChanged || appsChanged) && _file is not null) AtomicFile.Write(_file, JsonSerializer.Serialize(answer, ContractJson.Options));
        }
        if (changed) Changed?.Invoke();
    }

    private static bool Same(IReadOnlyList<string>? a, IReadOnlyList<string>? b) =>
        a is null ? b is null : b is not null && a.SequenceEqual(b, StringComparer.OrdinalIgnoreCase);

    /// <summary>Whether two approved lists say the same thing; only used to decide whether the file has to be written again.</summary>
    private static bool SameApproved(IReadOnlyList<ApprovedAppEntry> a, IReadOnlyList<ApprovedAppEntry> b) =>
        a.Count == b.Count && a.Zip(b).All(pair =>
            string.Equals(pair.First.Key, pair.Second.Key, StringComparison.OrdinalIgnoreCase)
            && pair.First.Kind == pair.Second.Kind
            && string.Equals(pair.First.Name, pair.Second.Name, StringComparison.OrdinalIgnoreCase)
            && string.Equals(pair.First.Path, pair.Second.Path, StringComparison.OrdinalIgnoreCase)
            && string.Equals(pair.First.ServiceName, pair.Second.ServiceName, StringComparison.OrdinalIgnoreCase));
}

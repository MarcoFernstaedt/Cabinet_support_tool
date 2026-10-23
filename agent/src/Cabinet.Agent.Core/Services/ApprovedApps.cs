using System.Text.Json;
using System.Text.RegularExpressions;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Services;

/// <summary>One program this cabinet may be asked to start, stop or restart, as the console's list names it.</summary>
public sealed record ApprovedApp(string Key, ApprovedAppKind Kind, string Name, string Program, string? ServiceName);

/// <summary>
/// The approved list this cabinet enforces (docs/spec/13-roadmap.md, milestone 10): the programs a start, stop, restart or
/// end may be aimed at, held as the agent's own copy of the list the server sent it. The list is never taken from a
/// request, and nothing is approved until the server has sent it, so an empty or unreadable copy approves nothing at all.
///
/// Every check is made against the program found on the machine now, by its whole path, exactly (ignoring case): a service
/// whose registered path has been pointed at another program is not the program that was approved, so it is refused. An
/// entry the contract would not allow is dropped rather than kept, and the first entry for a key wins.
/// </summary>
public sealed class ApprovedApps
{
    /// <summary>Nothing approved: what a cabinet with no list, or no list it can read, enforces.</summary>
    public static ApprovedApps None { get; } = new([]);

    /// <summary>The contract's approvedAppKey; checked again so a tampered list cannot name something else.</summary>
    private static readonly Regex KeyPattern = new("^app:[^\\\\/:*?\"<>|]{1,59}$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));

    /// <summary>The contract's windowsProgramPath: an absolute local path to a program file, no arguments.</summary>
    private static readonly Regex ProgramPattern = new(@"^[A-Za-z]:\\(?!.*(^|\\)\.{1,2}(\\|$))[^\u0000-\u001f\u007f<>:""/|?*]+\.[Ee][Xx][Ee]$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));

    /// <summary>The contract's shortText: one line, no control characters.</summary>
    private static readonly Regex TextPattern = new("^[^\u0000-\u001f\u007f]*$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));

    private const int MostEntries = 32;

    public ApprovedApps(IEnumerable<ApprovedAppEntry> entries)
    {
        var kept = new List<ApprovedApp>();
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (ApprovedAppEntry entry in entries)
        {
            if (kept.Count == MostEntries) break;
            if (!Usable(entry) || !keys.Add(entry.Key)) continue;
            kept.Add(new ApprovedApp(entry.Key, entry.Kind, entry.Name, entry.Path, entry.ServiceName));
        }
        Entries = kept;
    }

    /// <summary>The entries the agent will act on, in the order the server sent them.</summary>
    public IReadOnlyList<ApprovedApp> Entries { get; }

    public bool IsEmpty => Entries.Count == 0;

    /// <summary>The entry that names this service, if one does.</summary>
    public ApprovedApp? ForService(string serviceName) => Entries.FirstOrDefault(e =>
        e.Kind == ApprovedAppKind.Service && string.Equals(e.ServiceName, serviceName, StringComparison.OrdinalIgnoreCase));

    /// <summary>The entry that pins this program's path, if one does.</summary>
    public ApprovedApp? ForProgram(string? program) => program is null
        ? null
        : Entries.FirstOrDefault(e => string.Equals(e.Program, program, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Refuses service.control unless the service's key name is on the list and the program its registered path points at
    /// now is the program the entry named. <paramref name="registeredProgram"/> is null when Windows would not say: an
    /// unreadable program is refused, never assumed approved.
    /// </summary>
    public void RefuseServiceControl(string serviceKeyName, string? registeredProgram)
    {
        ApprovedApp entry = ForService(serviceKeyName) ?? throw new OperationFailedException("execution_failed",
            $"{serviceKeyName} is not on this cabinet's approved list, so the agent will not start, stop or restart it.");
        if (registeredProgram is null || !string.Equals(entry.Program, registeredProgram, StringComparison.OrdinalIgnoreCase))
            throw new OperationFailedException("execution_failed",
                $"{serviceKeyName} does not run the program the approved list named, so the agent will not start, stop or restart it.");
    }

    /// <summary>
    /// Refuses process.end unless the program running under that process ID is on the list. A process whose program could
    /// not be read is refused.
    /// </summary>
    public void RefuseProcessEnd(long processId, string name, string? program)
    {
        if (program is null)
            throw new OperationFailedException("execution_failed",
                $"The agent could not read which program process {processId} ({name}) runs, so it will not end it.");
        if (ForProgram(program) is null)
            throw new OperationFailedException("execution_failed",
                $"{name} (process {processId}) is not on this cabinet's approved list, so the agent will not end it.");
    }

    private static bool Usable(ApprovedAppEntry entry) =>
        KeyPattern.IsMatch(entry.Key)
        && entry.Name.Length is > 0 and <= 256 && TextPattern.IsMatch(entry.Name)
        && entry.Path.Length is >= 4 and <= 260 && ProgramPattern.IsMatch(entry.Path)
        && entry.Kind switch
        {
            ApprovedAppKind.Service => entry.ServiceName is not null && ServiceRules.IsValidName(entry.ServiceName),
            ApprovedAppKind.Application => entry.ServiceName is null,
            _ => false,
        };
}

/// <summary>
/// The approved list as the broker holds it: the cabinet's own copy on disk, which the network service writes from the
/// heartbeat answer (MonitorSettings) because the broker never touches the network. The copy is read again when the file
/// changes, so a list the console changes takes effect without a broker restart, and a file that is missing, unreadable or
/// not what the contract allows leaves the copy already in force — which is never a wider one.
/// </summary>
public sealed class ApprovedAppsFile
{
    private readonly string? _file;
    private readonly Action<string> _log;
    private readonly object _gate = new();
    private ApprovedApps _current = ApprovedApps.None;
    private (long Length, DateTime Written) _read = (-1, DateTime.MinValue);

    /// <param name="file">The heartbeat answer the network service keeps, or null when the broker has none.</param>
    public ApprovedAppsFile(string? file, Action<string> log)
    {
        _file = file;
        _log = log;
    }

    /// <summary>The list in force now.</summary>
    public ApprovedApps Current
    {
        get { lock (_gate) { Refresh(); return _current; } }
    }

    private void Refresh()
    {
        if (_file is null) return;
        try
        {
            var info = new FileInfo(_file);
            if (!info.Exists || (info.Length, info.LastWriteTimeUtc) == _read) return;
            if (!StrictJson.TryParse(File.ReadAllBytes(_file), 256 * 1024, out JsonDocument? document))
            {
                _log($"{_file} is not JSON; the approved list already in force stays.");
                return;
            }
            using (document)
            {
                if (!ContractSchemas.Instance.IsValid(ContractSchemas.Envelope("heartbeat-response"), document!.RootElement))
                {
                    _log($"{_file} is not a heartbeat answer; the approved list already in force stays.");
                    return;
                }
                var answer = document.RootElement.Deserialize<HeartbeatResponse>(ContractJson.Options)!;
                _read = (info.Length, info.LastWriteTimeUtc);
                _current = new ApprovedApps(answer.ApprovedApps?.Entries ?? []);
                _log($"Approved list in force: {_current.Entries.Count} program(s).");
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            _log($"The approved list could not be read ({e.GetType().Name}); the list already in force stays.");
        }
    }
}

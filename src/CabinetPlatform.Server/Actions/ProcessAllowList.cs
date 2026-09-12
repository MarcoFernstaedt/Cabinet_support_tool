using System.Collections.Immutable;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Actions;

/// <summary>Which processes and applications support staff may act on.</summary>
public sealed class ProcessControlOptions
{
    /// <summary>Configuration section this binds from.</summary>
    public const string SectionName = "ProcessControl";

    /// <summary>
    /// Image names support staff may end, without path or extension.
    /// </summary>
    /// <remarks>
    /// An allow-list, and deployment configuration rather than a request
    /// parameter: nothing a caller sends can add to it. The defaults cover the
    /// CUBEX and ZIMBIS application stack and the handful of ordinary Windows
    /// applications that hang on these machines and have to be cleared before a
    /// clinician can dispense.
    /// </remarks>
    public List<string> Processes { get; set; } = new()
    {
        "MashuraCabinetUI",
        "MashuraDispenseHost",
        "MashuraSyncAgent",
        "MashuraReportViewer",
        "CubexClient",
        "CubexDeviceHost",
        "ZimbisClient",
        "ZimbisDeviceHost",
        "AcroRd32",
        "Acrobat",
        "EXCEL",
        "WINWORD",
        "notepad",
        "mmc",
        "splwow64",
    };

    /// <summary>
    /// Applications a restart action may stop and relaunch, by name.
    /// </summary>
    /// <remarks>
    /// Names only. The executable each one relaunches comes from the agent's
    /// own registered install path for that name, on that machine. There is no
    /// path anywhere in this configuration, in the catalog, or on the wire: a
    /// path the server could supply would be a command line in everything but
    /// spelling.
    /// </remarks>
    public List<string> Applications { get; set; } = new()
    {
        "MashuraCabinetUI",
        "MashuraDispenseHost",
        "MashuraSyncAgent",
        "CubexClient",
        "ZimbisClient",
    };
}

/// <summary>
/// The processes no request may ever name, at any role, with any grant.
/// </summary>
/// <remarks>
/// <para>
/// A deny-list rather than configuration, and deliberately not overridable.
/// Ending <c>lsass</c> bluescreens Windows immediately; ending
/// <c>csrss</c>, <c>wininit</c>, <c>winlogon</c>, <c>services</c> or
/// <c>smss</c> does the same or leaves the machine in a state only a power
/// cycle clears. On a cabinet holding controlled substances that is not a
/// support action, it is an outage and a site visit.
/// </para>
/// <para>
/// The list is enforced here, before dispatch, and again on the agent, which
/// keeps its own copy. Two independent checks fail independently: a
/// compromised or simply buggy server still cannot talk an agent into killing
/// <c>lsass</c>.
/// </para>
/// <para>
/// The agent's own process is on the agent's list rather than this one,
/// because only the agent knows what it is called on that machine and what its
/// process id is. It refuses to end itself under any circumstance.
/// </para>
/// </remarks>
public static class CriticalProcessDenyList
{
    /// <summary>The names, compared without case and without extension.</summary>
    public static readonly ImmutableHashSet<string> Names = ImmutableHashSet.Create(
        StringComparer.OrdinalIgnoreCase,
        "system",
        "system idle process",
        "registry",
        "memory compression",
        "secure system",
        "smss",
        "csrss",
        "wininit",
        "winlogon",
        "services",
        "lsass",
        "lsaiso",
        "svchost",
        "fontdrvhost",
        "dwm",
        "MsMpEng",
        "CabinetPlatform.Agent");

    /// <summary>
    /// Whether a name is one this platform will never end.
    /// </summary>
    /// <param name="processName">The image name, with or without extension.</param>
    public static bool IsCritical(string? processName)
    {
        if (string.IsNullOrWhiteSpace(processName))
        {
            return false;
        }

        string candidate = Normalise(processName);

        return Names.Contains(candidate);
    }

    /// <summary>
    /// Strips a trailing <c>.exe</c> and surrounding whitespace, so that
    /// <c>LSASS.EXE</c> and <c>lsass</c> are the same name.
    /// </summary>
    /// <param name="processName">The name as supplied.</param>
    public static string Normalise(string processName)
    {
        string candidate = processName.Trim();

        return candidate.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? candidate[..^4]
            : candidate;
    }
}

/// <summary>Validates a requested process or application name.</summary>
public interface IProcessAllowList
{
    /// <summary>Whether this image name may be ended.</summary>
    /// <param name="processName">The name, with or without extension.</param>
    bool IsProcessAllowed(string? processName);

    /// <summary>Whether this application may be stopped and relaunched.</summary>
    /// <param name="applicationName">The application's registered name.</param>
    bool IsApplicationAllowed(string? applicationName);

    /// <summary>The image names this deployment permits.</summary>
    IReadOnlyCollection<string> AllowedProcesses { get; }

    /// <summary>The applications this deployment permits restarting.</summary>
    IReadOnlyCollection<string> AllowedApplications { get; }
}

/// <summary>
/// Configuration-backed implementation, with the deny-list applied first.
/// </summary>
/// <remarks>
/// Order matters and is not an accident: the deny-list is consulted before the
/// allow-list, so a deployment that mistakenly lists <c>lsass</c> as
/// permissible still cannot reach it. A misconfiguration should cost a refused
/// action, never a bluescreened cabinet.
/// </remarks>
public sealed class ProcessAllowList : IProcessAllowList
{
    /// <summary>
    /// The shape a Windows image name may take.
    /// </summary>
    /// <remarks>
    /// Checked before the name is compared to anything, so a value carrying
    /// path separators, quotes, wildcards or control characters is refused on
    /// sight rather than being matched against a list it could never have been
    /// on.
    /// </remarks>
    private static readonly Regex ValidName = new(
        @"^[A-Za-z0-9_.\-]{1,128}$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private readonly ImmutableHashSet<string> _processes;
    private readonly ImmutableHashSet<string> _applications;

    /// <summary>Creates the allow-list.</summary>
    /// <param name="options">Deployment configuration.</param>
    public ProcessAllowList(IOptions<ProcessControlOptions> options)
    {
        _processes = options.Value.Processes
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Select(CriticalProcessDenyList.Normalise)
            .Where(name => !CriticalProcessDenyList.IsCritical(name))
            .ToImmutableHashSet(StringComparer.OrdinalIgnoreCase);

        _applications = options.Value.Applications
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Select(CriticalProcessDenyList.Normalise)
            .Where(name => !CriticalProcessDenyList.IsCritical(name))
            .ToImmutableHashSet(StringComparer.OrdinalIgnoreCase);
    }

    /// <inheritdoc />
    public IReadOnlyCollection<string> AllowedProcesses => _processes;

    /// <inheritdoc />
    public IReadOnlyCollection<string> AllowedApplications => _applications;

    /// <inheritdoc />
    public bool IsProcessAllowed(string? processName) => IsPermitted(processName, _processes);

    /// <inheritdoc />
    public bool IsApplicationAllowed(string? applicationName) => IsPermitted(applicationName, _applications);

    private static bool IsPermitted(string? name, ImmutableHashSet<string> permitted)
    {
        if (string.IsNullOrWhiteSpace(name) || !ValidName.IsMatch(name.Trim()))
        {
            return false;
        }

        string candidate = CriticalProcessDenyList.Normalise(name);

        // The deny-list wins, always and regardless of what is configured.
        return !CriticalProcessDenyList.IsCritical(candidate) && permitted.Contains(candidate);
    }
}

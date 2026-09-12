using System.Text.RegularExpressions;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Actions;

/// <summary>
/// The agent's own decision about whether a process may be ended, and whether
/// an application may be relaunched.
/// </summary>
/// <remarks>
/// <para>
/// The server checks all of this first. This exists because the server checking
/// it is not the same as the agent being safe. A compromised server, or simply
/// a buggy one, must not be able to talk a cabinet into ending
/// <c>lsass</c> — which bluescreens Windows immediately — or into killing the
/// agent that is the only remaining way to reach the machine. Two independent
/// checks fail independently.
/// </para>
/// <para>
/// The critical-process list here is compiled in rather than configured, so a
/// mistake in a deployment's configuration cannot widen it. The agent's own
/// process is handled separately again, by identity rather than by name,
/// because only the agent knows what it is actually called and what id it holds.
/// </para>
/// </remarks>
public sealed class ProcessTargetPolicy
{
    /// <summary>
    /// The processes this agent will never end, whatever it is asked.
    /// </summary>
    /// <remarks>
    /// A second copy of the server's list, on purpose. Ending any of these
    /// takes the machine down at once — <c>lsass</c> with a bluescreen, the
    /// others by leaving Windows in a state only a power cycle clears — and on
    /// a cabinet holding controlled substances that is an outage, a site visit
    /// and an interrupted chain-of-custody record rather than a support action.
    /// </remarks>
    public static readonly IReadOnlySet<string> CriticalProcesses =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
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
        };

    /// <summary>
    /// Process id 4 is the Windows kernel on every version of Windows there is.
    /// </summary>
    public const int SystemProcessId = 4;

    /// <summary>The shape a Windows image name may take.</summary>
    private static readonly Regex ValidName = new(
        @"^[A-Za-z0-9_.\-]{1,128}$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private readonly HashSet<string> _allowed;
    private readonly Dictionary<string, string> _applications;
    private readonly IProcessControlGateway _processes;

    /// <summary>Creates the policy.</summary>
    /// <param name="options">Deployment configuration for this machine.</param>
    /// <param name="processes">Reads this agent's own identity.</param>
    public ProcessTargetPolicy(IOptions<AgentOptions> options, IProcessControlGateway processes)
    {
        _processes = processes;

        _allowed = new HashSet<string>(
            options.Value.Actions.ProcessAllowList
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Select(Normalise),
            StringComparer.OrdinalIgnoreCase);

        _applications = options.Value.Actions.ApplicationInstallPaths
            .Where(pair => !string.IsNullOrWhiteSpace(pair.Key) && !string.IsNullOrWhiteSpace(pair.Value))
            .ToDictionary(
                pair => Normalise(pair.Key),
                pair => pair.Value.Trim(),
                StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>The image names this agent will end.</summary>
    public IReadOnlyCollection<string> AllowedProcesses => _allowed;

    /// <summary>
    /// Whether this agent will end processes under the given name.
    /// </summary>
    /// <param name="processName">The image name, with or without extension.</param>
    /// <param name="failureReason">Why it was refused, when it was.</param>
    public bool IsProcessAllowed(string? processName, out string failureReason)
    {
        if (string.IsNullOrWhiteSpace(processName))
        {
            failureReason = "No process name was supplied.";
            return false;
        }

        string candidate = Normalise(processName);

        if (!ValidName.IsMatch(candidate))
        {
            failureReason = "The process name is not a valid Windows image name.";
            return false;
        }

        // Refused before the allow-list is consulted, so a deployment that
        // mistakenly lists one of these still cannot reach it.
        if (CriticalProcesses.Contains(candidate))
        {
            failureReason =
                $"'{candidate}' is a critical Windows process. This agent will not end it under any " +
                "circumstance: doing so takes the cabinet down immediately, in some cases with a " +
                "bluescreen.";
            return false;
        }

        // By name as well as by id, because a kill-by-name would otherwise find
        // the agent among its matches and end the only remaining way to reach
        // this machine.
        if (candidate.Equals(Normalise(_processes.CurrentProcessName), StringComparison.OrdinalIgnoreCase))
        {
            failureReason =
                "This agent will not end its own process. Doing so would remove the only remaining " +
                "way to reach this cabinet.";
            return false;
        }

        if (_allowed.Count == 0)
        {
            // An empty list denies everything. An agent that silently permitted
            // every process because nobody configured it would be far worse
            // than one that refuses until somebody does.
            failureReason =
                $"This agent's process allow-list is empty, so '{candidate}' cannot be ended. " +
                "Configure Agent:Actions:ProcessAllowList on this machine.";
            return false;
        }

        if (!_allowed.Contains(candidate))
        {
            failureReason = $"The process '{candidate}' is not in this agent's allow-list.";
            return false;
        }

        failureReason = string.Empty;
        return true;
    }

    /// <summary>
    /// Whether this agent will end a specific process id.
    /// </summary>
    /// <remarks>
    /// Checks the id itself as well as the name. The agent's own id is refused
    /// even if the name check somehow passed, because identity is the fact that
    /// matters and a name can be shared by a second copy of the same binary.
    /// </remarks>
    /// <param name="processId">The process id.</param>
    /// <param name="observedName">The image name Windows currently has for it.</param>
    /// <param name="failureReason">Why it was refused, when it was.</param>
    public bool IsProcessIdAllowed(int processId, string? observedName, out string failureReason)
    {
        if (processId <= 0)
        {
            failureReason = $"{processId} is not a process id.";
            return false;
        }

        if (processId == SystemProcessId)
        {
            failureReason = "Process id 4 is the Windows System process and is never a valid target.";
            return false;
        }

        if (processId == _processes.CurrentProcessId)
        {
            failureReason =
                "This agent will not end its own process. Doing so would remove the only remaining " +
                "way to reach this cabinet.";
            return false;
        }

        return IsProcessAllowed(observedName, out failureReason);
    }

    /// <summary>
    /// Resolves an application to the executable this machine launches it from.
    /// </summary>
    /// <remarks>
    /// The path comes from this machine's own configuration and from nowhere
    /// else. It is never supplied in a request and never sent by the server;
    /// an application with no registered path is refused rather than searched
    /// for, because guessing at an executable is how a restart action becomes
    /// arbitrary execution.
    /// </remarks>
    /// <param name="applicationName">The application's registered name.</param>
    /// <param name="executablePath">Its registered install path.</param>
    /// <param name="failureReason">Why it was refused, when it was.</param>
    public bool TryResolveApplication(
        string? applicationName, out string executablePath, out string failureReason)
    {
        executablePath = string.Empty;

        if (!IsProcessAllowed(applicationName, out failureReason))
        {
            return false;
        }

        string candidate = Normalise(applicationName!);

        if (!_applications.TryGetValue(candidate, out string? path))
        {
            failureReason =
                $"'{candidate}' has no registered install path on this cabinet, so there is nothing " +
                "to relaunch. Configure Agent:Actions:ApplicationInstallPaths on this machine. The " +
                "agent does not search for an executable and does not accept one in a request.";
            return false;
        }

        if (!Path.IsPathFullyQualified(path))
        {
            failureReason =
                $"The registered install path for '{candidate}' is not absolute, so it would be " +
                "resolved against whatever the agent's working directory happens to be.";
            return false;
        }

        executablePath = path;
        failureReason = string.Empty;
        return true;
    }

    /// <summary>Strips a trailing <c>.exe</c> so both spellings are one name.</summary>
    /// <param name="processName">The name as supplied.</param>
    public static string Normalise(string processName)
    {
        string candidate = processName.Trim();

        return candidate.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? candidate[..^4]
            : candidate;
    }
}

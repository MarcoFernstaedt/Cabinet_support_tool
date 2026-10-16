using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Core.Writes;

/// <summary>
/// The platform-independent rules behind the support actions: which processes are never ended, the exact arguments of shutdown.exe,
/// how DISM's answer is read, and the fixed names of the power settings. Compiled in, so the server cannot change them.
/// </summary>
public static class ActionRules
{
    /// <summary>Windows' own processes, the security software, remote-access tools and the platform's agent. Compared without ".exe", ignoring case.</summary>
    public static readonly IReadOnlySet<string> ProtectedProcesses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "System", "System Idle Process", "Idle", "Registry", "Secure System", "Memory Compression", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsm",
        "svchost", "dwm", "fontdrvhost", "LogonUI", "sihost", "taskhostw", "RuntimeBroker", "MsMpEng", "NisSrv", "SecurityHealthService", "SgrmBroker", "WmiPrvSE",
        "TermService", "rdpclip", "rdpinit", "sshd", "ssh-agent", "TeamViewer", "TeamViewer_Service", "AnyDesk", "winvnc", "tvnserver", "vncserver", "uvnc_service",
    };

    /// <summary>The platform's own programs by name prefix.</summary>
    public static readonly string[] ProtectedPrefixes = ["Cabinet.Agent", "CabinetAgent", "Mashura"];

    /// <summary>Why this process may not be ended, or null when it may. A process ID of 4 or less is the system itself.</summary>
    public static string? WhyNotEnd(long processId, string name, long ownProcessId)
    {
        if (processId <= 4) return "That is part of Windows itself.";
        if (processId == ownProcessId) return "That is the platform's own agent.";
        string bare = name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name;
        if (ProtectedProcesses.Contains(bare)) return "Windows, its security software or remote access depends on that process, so the platform never ends it.";
        if (ProtectedPrefixes.Any(p => bare.StartsWith(p, StringComparison.OrdinalIgnoreCase))) return "That is the platform's own agent.";
        return null;
    }

    /// <summary>The arguments for shutdown.exe. The message is one argument element, so nothing in it is ever read as a switch or a command.</summary>
    public static IReadOnlyList<string> RestartArguments(SystemRestartParams p)
    {
        if (p.Mode == RestartMode.Cancel) return ["/a"];
        var args = new List<string> { p.Mode == RestartMode.Restart ? "/r" : "/s", "/t", (p.DelaySeconds ?? 0).ToString(System.Globalization.CultureInfo.InvariantCulture), "/d", "p:0:0" };
        if (!string.IsNullOrWhiteSpace(p.Message)) { args.Add("/c"); args.Add(EventText.ShortText(p.Message, 200)); }
        return args;
    }

    /// <summary>DISM /CheckHealth's answer. Windows words it in the cabinet's language; anything not recognised is "unknown", never a guess.</summary>
    public static (ComponentStoreState State, string Summary) ReadDism(int exitCode, string output)
    {
        string text = output ?? "";
        if (text.Contains("not repairable", StringComparison.OrdinalIgnoreCase)) return (ComponentStoreState.Corrupt, "The component store is damaged and cannot be repaired by DISM alone.");
        if (text.Contains("is repairable", StringComparison.OrdinalIgnoreCase)) return (ComponentStoreState.Repairable, "The component store is damaged and can be repaired.");
        if (text.Contains("No component store corruption detected", StringComparison.OrdinalIgnoreCase)) return (ComponentStoreState.Healthy, "No component store corruption detected.");
        string first = text.Split('\n').Select(l => EventText.ShortText(l, 200)).FirstOrDefault(l => l.Length > 0 && !l.StartsWith("Deployment Image", StringComparison.OrdinalIgnoreCase) && !l.StartsWith("Version", StringComparison.OrdinalIgnoreCase)) ?? "";
        return (ComponentStoreState.Unknown, first.Length > 0 ? first : $"DISM gave no answer that could be read (exit code {exitCode}).");
    }
}

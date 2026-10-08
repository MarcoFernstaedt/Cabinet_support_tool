namespace Cabinet.Agent.Core.Upgrades;

public sealed record SelfCheckResult(bool Skipped, int Checked, IReadOnlyList<(string File, string Problem)> Problems)
{
    public bool Passed => !Skipped && Problems.Count == 0;
}

/// <summary>
/// The agent's check of its own files (docs/spec/04-agent-spec.md "Runtime"): every binary in the program
/// folder must carry a valid Authenticode signature from the agent's publisher. Run at start-up and once a day;
/// a mismatch is reported to the server as a security event. A build with no publisher compiled in (a developer
/// build) cannot check itself, and says so instead of reporting every file.
/// </summary>
public sealed class SelfCheck(string programFolder, UpgradeTrust trust, IAuthenticode authenticode)
{
    public const int MaxFiles = 2000;

    public SelfCheckResult Run()
    {
        if (!trust.HasPublisher) return new SelfCheckResult(true, 0, []);
        var problems = new List<(string, string)>();
        int checkedCount = 0;
        foreach (string required in AgentLayout.RequiredPrograms.Take(2))
            if (!File.Exists(Path.Combine(programFolder, required))) problems.Add((required.Replace('\\', '/'), "It is missing."));
        foreach (string path in Directory.EnumerateFiles(programFolder, "*", SearchOption.AllDirectories).Take(MaxFiles))
        {
            if (!AgentLayout.IsBinary(path)) continue;
            checkedCount++;
            if (AgentSignatures.Problem(path, trust, authenticode) is { } why)
                problems.Add((Path.GetRelativePath(programFolder, path).Replace('\\', '/'), why));
        }
        return new SelfCheckResult(false, checkedCount, problems);
    }
}

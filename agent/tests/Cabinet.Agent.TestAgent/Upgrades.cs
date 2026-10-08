using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Upgrades;

namespace Cabinet.Agent.TestAgent;

/// <summary>
/// Authenticode on Linux, for the test agent only: a test binary says in its bytes whether it is signed and by
/// which certificate ("MZ|signed:agent-signer" reads agent-signer.pem from the trust folder, chain.pem holds the
/// intermediates), unsigned ("MZ|unsigned") or changed after signing ("MZ|tampered"). The publisher match and the
/// chain to the pinned root are the agent's real code. Real WinVerifyTrust runs on the Windows CI runner.
/// </summary>
public sealed class MarkerAuthenticode(string trustDir) : IAuthenticode
{
    public int Verify(string path)
    {
        string text = File.ReadAllText(path);
        if (text.Contains("|unsigned")) return unchecked((int)0x800B0100);
        if (text.Contains("|tampered")) return unchecked((int)0x80096010);
        return 0;
    }

    public (X509Certificate2 Signer, X509Certificate2Collection Certificates)? ReadSignature(string path)
    {
        string text = File.ReadAllText(path);
        int at = text.IndexOf("|signed:", StringComparison.Ordinal);
        if (at < 0) return null;
        string name = new(text[(at + 8)..].TakeWhile(c => char.IsAsciiLetterOrDigit(c) || c == '-').ToArray());
        var chain = new X509Certificate2Collection();
        string chainFile = Path.Combine(trustDir, "chain.pem");
        if (File.Exists(chainFile)) chain.ImportFromPemFile(chainFile);
        return (X509Certificate2.CreateFromPem(File.ReadAllText(Path.Combine(trustDir, name + ".pem"))), chain);
    }
}

/// <summary>
/// The updater, simulated: the test agent cannot replace and restart itself, so it records what the real updater
/// would: the new version checked in (succeeded), or it did not and the old version was restored (rolled back).
/// The network side then reports the journal to the server exactly as on a cabinet.
/// </summary>
public sealed class SimulatedUpdater(UpgradeJournalStore journal, bool rollBack, Action<string> log) : IUpdaterLauncher
{
    public bool Running => false;

    public void Launch(string verb)
    {
        UpgradeJournal j = journal.Read() ?? throw new InvalidOperationException("no journal");
        log($"Simulated updater ({verb}): {(rollBack ? "the new version does not check in; restoring" : "the new version checks in")}.");
        journal.Write(rollBack
            ? j with { Phase = UpgradePhase.RolledBack, Check = UpgradeCheck.CheckIn, FinishedAt = DateTimeOffset.UtcNow, Message = $"Version {j.Version} did not check in with the server within 5 minutes. {j.FromVersion} was restored." }
            : j with { Phase = UpgradePhase.Succeeded, FinishedAt = DateTimeOffset.UtcNow, Message = $"{j.Version} is running and checked in." });
    }
}

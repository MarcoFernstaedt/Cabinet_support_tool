using System.Security.Cryptography.X509Certificates;

namespace Cabinet.Agent.Core.Upgrades;

/// <summary>What only Windows can do for an Authenticode-signed file.</summary>
public interface IAuthenticode
{
    /// <summary>Windows' own trust verification (WinVerifyTrust, offline): 0 when the signature and the file match and chain to a trusted root.</summary>
    int Verify(string path);
    /// <summary>The signer and every certificate in the file's embedded signature, or null when it has none.</summary>
    (X509Certificate2 Signer, X509Certificate2Collection Certificates)? ReadSignature(string path);
}

/// <summary>
/// The agent's files on disk: one folder per program under the install folder, as the installer and every release
/// lay them out. A release must contain the three programs the updater puts in place.
/// </summary>
public static class AgentLayout
{
    public static readonly IReadOnlyList<string> RequiredPrograms =
    [
        Path.Combine("Cabinet.Agent.Broker", "Cabinet.Agent.Broker.exe"),
        Path.Combine("Cabinet.Agent.Network", "Cabinet.Agent.Network.exe"),
        Path.Combine("Cabinet.Agent.Updater", "Cabinet.Agent.Updater.exe"),
    ];

    /// <summary>
    /// Every program a release carries: the three above, plus the local harness the installer deploys. The
    /// architecture check reads the PE machine of each of these that the package holds, so a release assembled for
    /// the other architecture is refused whichever of its programs is looked at first.
    /// </summary>
    public static readonly IReadOnlyList<string> ReleasePrograms =
    [
        .. RequiredPrograms,
        Path.Combine("Cabinet.Agent.Harness", "cabinet-harness.exe"),
    ];

    private static readonly HashSet<string> BinaryExtensions = new(StringComparer.OrdinalIgnoreCase) { ".exe", ".dll", ".sys", ".ocx", ".cpl", ".scr", ".drv", ".efi", ".mui", ".winmd" };

    /// <summary>A file that must carry the agent's Authenticode signature: anything Windows could load as code (by name, or because it starts with "MZ").</summary>
    public static bool IsBinary(string path)
    {
        if (BinaryExtensions.Contains(Path.GetExtension(path))) return true;
        try
        {
            using FileStream f = File.OpenRead(path);
            return f.ReadByte() == 'M' && f.ReadByte() == 'Z';
        }
        catch (IOException) { return true; } // unreadable: check it, which then fails
    }
}

/// <summary>
/// The Authenticode check every agent binary must pass, during an upgrade and in the self-check: Windows trusts the
/// signature and the file still matches it, and the signer is the agent's own publisher, chained to its pinned root.
/// </summary>
public static class AgentSignatures
{
    /// <returns>Null when the file passes; otherwise why not.</returns>
    public static string? Problem(string path, UpgradeTrust trust, IAuthenticode authenticode)
    {
        int code = authenticode.Verify(path);
        if (code != 0) return $"Windows does not accept its signature (0x{code:X8}).";
        var signature = authenticode.ReadSignature(path);
        if (signature is not { } s) return "It is not signed.";
        if (trust.MatchPublisher(s.Signer, s.Certificates) is null)
            return $"It is signed by \"{s.Signer.GetNameInfo(X509NameType.SimpleName, false)}\", not the agent's publisher.";
        return null;
    }
}

using System.Diagnostics;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Core.Packages;
using Cabinet.Agent.Core.Upgrades;

namespace Cabinet.Agent.Windows;

/// <summary>Windows' Authenticode: WinVerifyTrust offline (no revocation fetching, no network), and the signer and certificates embedded in the file.</summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsAuthenticode : IAuthenticode
{
    public int Verify(string path) => WinTrust.Verify(path);

    public (X509Certificate2 Signer, X509Certificate2Collection Certificates)? ReadSignature(string path)
    {
        X509Certificate2 signer;
        try
        {
#pragma warning disable SYSLIB0057 // reads the Authenticode signer only; the trust decision is WinVerifyTrust's and the pinned publisher's
            signer = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
#pragma warning restore SYSLIB0057
        }
        catch (CryptographicException) { return null; }
        X509Certificate2Collection certs;
        try { certs = WinTrust.EmbeddedCertificates(path); }
        catch (PackageRefusedException) { certs = []; }
        return (signer, certs);
    }
}

/// <summary>
/// Starts the signed updater for the broker. The updater is copied out of the program folder into the broker's
/// own folder first (it is about to replace the program folder), its signature checked again on the copy, and
/// it is started by full path with one fixed verb, never through a shell. It holds a machine-wide mutex while
/// it runs, so the broker never starts a second one.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class UpdaterLauncher(UpgradeTrust trust, IAuthenticode authenticode, Action<string> log) : IUpdaterLauncher
{
    public const string MutexName = @"Global\Mashura.CabinetAgent.Updater";
    private static readonly HashSet<string> Verbs = ["run", "resume"];

    public bool Running
    {
        get
        {
            if (!Mutex.TryOpenExisting(MutexName, out Mutex? m)) return false;
            m.Dispose();
            return true;
        }
    }

    public void Launch(string verb)
    {
        if (!Verbs.Contains(verb)) throw new InvalidOperationException("The updater takes only run or resume.");
        string installed = Path.Combine(AgentPaths.ProgramFolder, "Cabinet.Agent.Updater", "Cabinet.Agent.Updater.exe");
        string copy = AgentPaths.UpdaterCopy;
        // Resuming after a cut-short upgrade: the program folder may be half replaced, so the copy already there is used.
        if (verb == "run" || !File.Exists(copy))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(copy)!);
            File.Copy(installed, copy, overwrite: true);
        }
        if (trust.HasPublisher && AgentSignatures.Problem(copy, trust, authenticode) is { } why)
            throw new InvalidOperationException($"The updater's own signature does not check out: {why}");
        var start = new ProcessStartInfo(copy) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(copy)! };
        start.ArgumentList.Add(verb);
        using Process p = Process.Start(start) ?? throw new InvalidOperationException("The updater did not start.");
        log($"Started the updater ({verb}), process {p.Id}.");
    }
}

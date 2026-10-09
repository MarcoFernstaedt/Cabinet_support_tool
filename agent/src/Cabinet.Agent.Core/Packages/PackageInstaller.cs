using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Packages;

/// <summary>What only Windows can do for a package: its own trust check, reading an MSI's signature, and installing.</summary>
public interface IPackagePlatform
{
    /// <summary>Windows trust verification of a signed file (a catalog or an MSI). Throws <see cref="PackageRefusedException"/> (signature_invalid) when it fails.</summary>
    void VerifyWithWindows(string path);
    /// <summary>The signer and certificates embedded in an MSI's Authenticode signature.</summary>
    (X509Certificate2 Signer, X509Certificate2Collection Certificates) ReadMsiSignature(string path);
    (bool Installed, long ExitCode, bool RebootRequired) InstallDriver(IReadOnlyList<string> infPaths);
    (bool Installed, long ExitCode, bool RebootRequired) InstallMsi(string msiPath);
    (bool Removed, bool RebootRequired) UninstallDriver(string publishedName);
}

/// <summary>
/// package.install and driver.uninstall as the broker runs them (docs/spec/04-agent-spec.md
/// "Package handling on the cabinet"). The network process downloads the package into its own
/// folder; the broker copies it into a staging folder only it can write to and checks that copy:
/// hash, then signature, then publisher, before anything is installed. Staging is emptied after
/// every install, whatever happened. Packages are never run from anywhere else, and never kept.
/// </summary>
public sealed class PackageInstaller(string downloads, string staging, TrustList trust, IPackagePlatform platform, Action<string> log)
{
    public const long MaxPackageBytes = 500L * 1024 * 1024;

    public static string DownloadPath(string downloads, Guid packageId) => Path.Combine(downloads, packageId.ToString("N") + ".pkg");

    public OperationRegistry Register(OperationRegistry registry) => registry
        .Register<PackageInstallParams, PackageInstallOutput>(Catalog.PackageInstall, (p, _) => Task.FromResult(Install(p)))
        .Register<DriverUninstallParams, DriverUninstallOutput>(Catalog.DriverUninstall, (p, _) => Task.FromResult(Uninstall(p)));

    public PackageInstallOutput Install(PackageInstallParams p)
    {
        Guid command = OperationContext.CommandId ?? throw new OperationFailedException("execution_failed", "A write ran without its command.");
        string source = DownloadPath(downloads, p.PackageId);
        string work = Path.Combine(staging, command.ToString("N"));
        try
        {
            if (!File.Exists(source)) throw new OperationFailedException("unavailable", "The package was not downloaded.");
            if (new FileInfo(source).Length > MaxPackageBytes) throw new OperationFailedException("hash_mismatch", "The package is larger than any package may be.");
            Directory.CreateDirectory(work);
            string copy = Path.Combine(work, p.PackageType == PackageType.Msi ? "package.msi" : "package.zip");
            File.Copy(source, copy);

            // 1. Hash: the copy only the broker can write is the one checked and installed.
            string actual;
            using (FileStream f = File.OpenRead(copy)) actual = Convert.ToHexString(SHA256.HashData(f)).ToLowerInvariant();
            if (actual != p.Sha256) throw new OperationFailedException("hash_mismatch", "The package's SHA-256 hash does not match the approved package.");

            // 2 and 3. Signature, then publisher.
            string signer;
            (bool installed, long exit, bool reboot) outcome;
            if (p.PackageType == PackageType.Driver)
            {
                string folder = Path.Combine(work, "files");
                var files = DriverPackage.Extract(copy, folder);
                var (infs, publisher) = DriverPackage.Check(folder, files, trust);
                foreach (string cat in files.Where(f => f.EndsWith(".cat", StringComparison.OrdinalIgnoreCase)))
                    platform.VerifyWithWindows(Path.Combine(folder, cat));
                signer = publisher;
                outcome = platform.InstallDriver(infs.Select(i => Path.Combine(folder, i)).ToList());
            }
            else
            {
                platform.VerifyWithWindows(copy);
                var (leaf, certs) = platform.ReadMsiSignature(copy);
                TrustedPublisher publisher = trust.Match(leaf, certs, PackageType.Msi)
                    ?? throw new PackageRefusedException("publisher_not_trusted", $"The installer is signed by \"{leaf.GetNameInfo(X509NameType.SimpleName, false)}\", which is not a trusted publisher.");
                signer = publisher.Name;
                outcome = platform.InstallMsi(copy);
            }
            log($"Package {p.PackageId} ({p.PackageType}) from {signer}: {(outcome.installed ? "installed" : "not installed")}, exit code {outcome.exit}.");
            if (!outcome.installed) throw new OperationFailedException("execution_failed", $"The installer reported failure (exit code {outcome.exit}).");
            return new PackageInstallOutput
            {
                PackageId = p.PackageId, PackageType = p.PackageType,
                Checks = new PackageChecks { Hash = CheckOutcome.Passed, Signature = CheckOutcome.Passed, Publisher = CheckOutcome.Passed },
                Signer = Helpers.EventText.ShortText(signer), Installed = true, ExitCode = outcome.exit, RebootRequired = outcome.reboot,
            };
        }
        catch (PackageRefusedException e)
        {
            log($"Package {p.PackageId} refused: {e.Code}.");
            throw new OperationFailedException(e.Code, e.Message);
        }
        finally
        {
            // The download is left for the network service to remove: SYSTEM never deletes through a folder a less trusted
            // account can change, since that account could turn the folder into a link to somewhere else.
            try { if (Directory.Exists(work)) Directory.Delete(work, recursive: true); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { log($"Staging folder for {command} could not be emptied yet ({e.GetType().Name})."); }
        }
    }

    public DriverUninstallOutput Uninstall(DriverUninstallParams p)
    {
        var (removed, reboot) = platform.UninstallDriver(p.PublishedName.ToLowerInvariant());
        if (!removed) throw new OperationFailedException("not_found", "No third-party driver with that published name could be removed.");
        return new DriverUninstallOutput { PublishedName = p.PublishedName.ToLowerInvariant(), Removed = true, RebootRequired = reboot };
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }
}

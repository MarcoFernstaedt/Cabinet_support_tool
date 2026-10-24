using System.Security.Cryptography;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Packages;

namespace Cabinet.Agent.Core.Upgrades;

/// <summary>A release the broker will not install, with exactly which check refused it and the matching rejection code.</summary>
public sealed class UpgradeRefusedException(UpgradeCheck check, string code, string message) : Exception(message)
{
    public UpgradeCheck Check { get; } = check;
    public string Code { get; } = code;
}

public sealed record VerifiedRelease(UpgradeManifest Manifest, string Files);

/// <summary>
/// The broker's check of a downloaded release (docs/spec/07-upgrade-channel.md step 6), in the spec's order:
/// the manifest's signature against the compiled-in key; the zip's hash against the manifest; the version newer
/// than the running one (and the running one not older than the release's minimum); the Authenticode signature on
/// every binary; and, last, that every program in the release is built for the architecture this cabinet's agent is.
/// The network process only downloaded the files; the broker reads the manifest and signature once
/// into memory and copies the zip into its own staging folder before checking anything, so nothing can change
/// between the check and the install. Staging is emptied whenever a check fails.
/// </summary>
public sealed class ReleaseVerifier(UpgradeTrust trust, IAuthenticode authenticode)
{
    public const int MaxManifestBytes = 4096;
    public const int MaxSignatureBytes = 1024;
    public const long MaxPackageBytes = 500L * 1024 * 1024;

    public static string DownloadFolder(string downloads, string version) => Path.Combine(downloads, "agent-" + version);
    public const string ManifestFile = "manifest.json", SignatureFile = "signature.json", PackageFile = "package.zip";

    /// <param name="downloads">The network service's downloads folder; only the release's own subfolder is read.</param>
    /// <param name="staging">A folder only the broker can write; emptied and refilled.</param>
    public VerifiedRelease Verify(string downloads, string version, string runningVersion, string staging)
    {
        if (!SemVersion.TryParse(version, out SemVersion offered) || !SemVersion.TryParse(runningVersion, out SemVersion running))
            throw new UpgradeRefusedException(UpgradeCheck.Version, "verification_failed", "The version is not an agent version.");
        string source = DownloadFolder(downloads, offered.ToString());
        ResetFolder(staging);
        try
        {
            // 1. The manifest's signature, before a single field of the manifest is believed.
            byte[] manifestBytes = ReadSmall(Path.Combine(source, ManifestFile), MaxManifestBytes, UpgradeCheck.ManifestSignature);
            UpgradeSignature signature = Parse<UpgradeSignature>(ReadSmall(Path.Combine(source, SignatureFile), MaxSignatureBytes, UpgradeCheck.ManifestSignature),
                "upgrade-signature", UpgradeCheck.ManifestSignature, "The signature file does not match its contract.");
            if (!trust.VerifyManifest(manifestBytes, signature, out string problem))
                throw new UpgradeRefusedException(UpgradeCheck.ManifestSignature, "signature_invalid", problem);
            UpgradeManifest manifest = Parse<UpgradeManifest>(manifestBytes, "upgrade-manifest", UpgradeCheck.Manifest, "The signed manifest does not match its contract.");
            if (manifest.Product != UpgradeTrust.Product)
                throw new UpgradeRefusedException(UpgradeCheck.Manifest, "verification_failed", "The signed manifest is not for the cabinet agent.");
            if (manifest.Version != offered.ToString())
                throw new UpgradeRefusedException(UpgradeCheck.Manifest, "verification_failed", $"The signed manifest is for {manifest.Version}, not the offered {offered}.");

            // 2. The zip's hash, on the broker's own copy.
            string zip = Path.Combine(staging, PackageFile);
            string downloaded = Path.Combine(source, PackageFile);
            if (!File.Exists(downloaded)) throw new UpgradeRefusedException(UpgradeCheck.Download, "unavailable", "The package was not downloaded.");
            if (new FileInfo(downloaded).Length > MaxPackageBytes) throw new UpgradeRefusedException(UpgradeCheck.PackageHash, "hash_mismatch", "The package is larger than any release may be.");
            File.Copy(downloaded, zip);
            string actual;
            long size;
            using (FileStream f = File.OpenRead(zip)) { size = f.Length; actual = Convert.ToHexString(SHA256.HashData(f)).ToLowerInvariant(); }
            if (size != manifest.SizeBytes || actual != manifest.Sha256)
                throw new UpgradeRefusedException(UpgradeCheck.PackageHash, "hash_mismatch", "The package's SHA-256 hash does not match the signed manifest.");

            // 3. Never a downgrade, and never from a version the release was not built to upgrade.
            SemVersion minimum = SemVersion.Parse(manifest.MinimumVersion);
            if (offered <= running)
                throw new UpgradeRefusedException(UpgradeCheck.Version, "verification_failed", $"{offered} is not newer than the running {running}; agents never downgrade.");
            if (running < minimum)
                throw new UpgradeRefusedException(UpgradeCheck.Version, "verification_failed", $"{offered} upgrades only from {minimum} or later; this agent is {running}.");

            // 4. Every agent binary must carry the pinned publisher's signature in production. An explicitly built
            // development agent with no pinned publisher may use a release signed by its compiled release key: the
            // signed manifest still binds the full ZIP hash, exact version and all extracted paths. There is no
            // server-side switch or command parameter that can opt a strict agent into this mode.
            string files = Path.Combine(staging, "files");
            IReadOnlyList<string> entries;
            try { entries = DriverPackage.Extract(zip, files); }
            catch (PackageRefusedException e) { throw new UpgradeRefusedException(UpgradeCheck.PackageHash, "verification_failed", e.Message); }
            File.Delete(zip);
            foreach (string required in AgentLayout.RequiredPrograms)
                if (!File.Exists(Path.Combine(files, required)))
                    throw new UpgradeRefusedException(UpgradeCheck.Install, "verification_failed", $"The release does not contain {required.Replace('\\', '/')}.");
            if (!trust.HasPublisher && !UpgradeTrust.AllowsUnsignedDevelopmentUpgrades)
                throw new UpgradeRefusedException(UpgradeCheck.Authenticode, "publisher_not_trusted", "This agent has no code-signing publisher compiled in, so it cannot check the release's binaries.");
            if (trust.HasPublisher)
                foreach (string entry in entries)
                {
                    string path = Path.Combine(files, entry);
                    if (!AgentLayout.IsBinary(path)) continue;
                    if (AgentSignatures.Problem(path, trust, authenticode) is { } why)
                        throw new UpgradeRefusedException(UpgradeCheck.Authenticode, why.StartsWith("It is signed by", StringComparison.Ordinal) ? "publisher_not_trusted" : "signature_invalid",
                            $"{entry}: {why}");
                }

            // 5. Every program in the release must be built for the architecture this cabinet's agent is, read from the
            // program's own PE header rather than from anything the platform said. A 32-bit agent cannot be replaced by
            // a 64-bit one (nor the other way round) without the cabinet becoming a different machine to the platform
            // and to the next update, so this refuses a release of the other architecture here, on the extracted copy
            // the broker owns — the paths are built from that staging folder, never from the process's working
            // directory, which belongs to whoever started the broker. Nothing has been swapped when this throws: the
            // installation is untouched and this staging folder is emptied by the caller's catch.
            foreach (string program in AgentLayout.ReleasePrograms)
            {
                string path = Path.Combine(files, program);
                if (!File.Exists(path)) continue; // the three the updater installs are required above; the rest are read when the release carries them
                int? machine = PeImage.Machine(path);
                if (AgentArchitecture.FromPeMachine(machine) is not { } built)
                    throw new UpgradeRefusedException(UpgradeCheck.Install, "verification_failed",
                        $"{program.Replace('\\', '/')} is not a Windows program (PE machine {Machine(machine)}), so this release cannot be installed. Download the release again; if it keeps happening, send this line to support.");
                if (built != AgentArchitecture.Current)
                    throw new UpgradeRefusedException(UpgradeCheck.Install, "verification_failed",
                        $"The release's {program.Replace('\\', '/')} is built for {built} and this cabinet runs the {AgentArchitecture.Current} agent, so nothing was installed. Install the {AgentArchitecture.Current} release here: an upgrade never crosses architectures.");
            }
            return new VerifiedRelease(manifest, files);
        }
        catch
        {
            ResetFolder(staging);
            throw;
        }
    }

    private static string Machine(int? machine) => machine is { } m ? $"0x{m:X4}" : "unreadable";

    private static byte[] ReadSmall(string path, int max, UpgradeCheck check)
    {
        if (!File.Exists(path)) throw new UpgradeRefusedException(UpgradeCheck.Download, "unavailable", $"{Path.GetFileName(path)} was not downloaded.");
        if (new FileInfo(path).Length > max) throw new UpgradeRefusedException(check, "signature_invalid", $"{Path.GetFileName(path)} is larger than allowed.");
        return File.ReadAllBytes(path);
    }

    private static T Parse<T>(byte[] bytes, string schema, UpgradeCheck check, string message)
    {
        if (!StrictJson.TryParse(bytes, MaxManifestBytes, out JsonDocument? doc)) throw new UpgradeRefusedException(check, "verification_failed", message);
        using (doc)
        {
            if (!ContractSchemas.Instance.IsValid(ContractSchemas.Local(schema), doc!.RootElement)) throw new UpgradeRefusedException(check, "verification_failed", message);
            try { return doc.RootElement.Deserialize<T>(ContractJson.Options)!; }
            catch (JsonException) { throw new UpgradeRefusedException(check, "verification_failed", message); }
        }
    }

    public static void ResetFolder(string path)
    {
        if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        Directory.CreateDirectory(path);
    }
}

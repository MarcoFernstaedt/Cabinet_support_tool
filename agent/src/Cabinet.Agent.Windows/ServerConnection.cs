using System.Net.NetworkInformation;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Windows;

/// <summary>
/// The cabinet's private key in the Windows machine key store, created
/// non-exportable (docs/spec/02-security-model.md control 3): the agent can
/// sign with it but nothing, including the agent, can read it out.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class CngAgentKeyStore(string keyName = "Mashura.CabinetAgent") : IAgentKeyStore
{
    private static readonly CngProvider Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider;

    private ECDsaCng Open()
    {
        CngKey key = CngKey.Exists(keyName, Provider, CngKeyOpenOptions.MachineKey)
            ? CngKey.Open(keyName, Provider, CngKeyOpenOptions.MachineKey)
            : CngKey.Create(CngAlgorithm.ECDsaP256, keyName, new CngKeyCreationParameters
            {
                Provider = Provider, KeyCreationOptions = CngKeyCreationOptions.MachineKey, ExportPolicy = CngExportPolicies.None,
            });
        return new ECDsaCng(key);
    }

    public string CreateSigningRequestPem()
    {
        using ECDsaCng key = Open();
        return new CertificateRequest("CN=cabinet-agent", key, HashAlgorithmName.SHA256).CreateSigningRequestPem();
    }

    public X509Certificate2 WithPrivateKey(string certificatePem)
    {
        using var certificate = X509Certificate2.CreateFromPem(certificatePem);
        using ECDsaCng key = Open();
        return certificate.CopyWithPrivateKey(key);
    }

    /// <summary>Whether the key exists and refuses export, for the installed-service check.</summary>
    public bool IsNonExportable()
    {
        using ECDsaCng key = Open();
        return key.Key.ExportPolicy == CngExportPolicies.None;
    }
}

/// <summary>What the cabinet tells the server about itself when it asks to enroll.</summary>
[SupportedOSPlatform("windows")]
public static class Fingerprints
{
    public static EnrollFingerprints Read(SystemInfoOutput info) => new()
    {
        Hostname = info.Hostname,
        SerialNumber = info.SerialNumber is { Length: > 0 } s ? s : null,
        MacAddresses = NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.NetworkInterfaceType is NetworkInterfaceType.Ethernet or NetworkInterfaceType.Wireless80211 or NetworkInterfaceType.GigabitEthernet)
            .Select(n => n.GetPhysicalAddress().GetAddressBytes()).Where(b => b.Length == 6)
            .Select(b => string.Join('-', b.Select(x => x.ToString("X2", System.Globalization.CultureInfo.InvariantCulture))))
            .Distinct().Take(16).ToList(),
        ProvisionedClient = null,
        ProvisionedSite = null,
        OnlineSince = DateTimeOffset.UtcNow.AddSeconds(-info.UptimeSeconds),
        OsVersion = info.OsVersion,
        AgentVersion = info.AgentVersion,
    };
}

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
public sealed class CngAgentKeyStore(string keyName = CngAgentKeyStore.DefaultName) : IAgentKeyStore
{
    public const string DefaultName = "Mashura.CabinetAgent";
    private static readonly CngProvider Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider;
    private const CngPropertyOptions DaclSecurityInformation = (CngPropertyOptions)0x4;

    /// <summary>
    /// Run by the installer as an administrator: generates the cabinet's key in
    /// the machine key store, non-exportable, and lets only SYSTEM, administrators
    /// and the given account use it. Windows does not let the restricted network
    /// service create machine keys itself, and it should not be able to.
    /// </summary>
    /// <returns>True if a new key was created, false if it already existed (its access list is reset either way).</returns>
    public static bool Provision(string grantSid, string name = DefaultName)
    {
        bool created = false;
        CngKey key;
        if (CngKey.Exists(name, Provider, CngKeyOpenOptions.MachineKey)) key = CngKey.Open(name, Provider, CngKeyOpenOptions.MachineKey);
        else
        {
            key = CngKey.Create(CngAlgorithm.ECDsaP256, name, new CngKeyCreationParameters
            {
                Provider = Provider, KeyCreationOptions = CngKeyCreationOptions.MachineKey, ExportPolicy = CngExportPolicies.None,
            });
            created = true;
        }
        using (key)
        {
            var descriptor = new System.Security.AccessControl.RawSecurityDescriptor($"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GR;;;{new System.Security.Principal.SecurityIdentifier(grantSid).Value})");
            byte[] binary = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(binary, 0);
            key.SetProperty(new CngProperty("Security Descr", binary, DaclSecurityInformation));
        }
        return created;
    }

    public static void Delete(string name = DefaultName)
    {
        if (CngKey.Exists(name, Provider, CngKeyOpenOptions.MachineKey)) CngKey.Open(name, Provider, CngKeyOpenOptions.MachineKey).Delete();
    }

    /// <summary>The agent only opens the key; it never creates one.</summary>
    private ECDsaCng Open()
    {
        if (!CngKey.Exists(keyName, Provider, CngKeyOpenOptions.MachineKey))
            throw new CryptographicException("The cabinet's key has not been provisioned. Run the installer again.");
        return new ECDsaCng(CngKey.Open(keyName, Provider, CngKeyOpenOptions.MachineKey));
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

    /// <summary>Whether the key refuses export.</summary>
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

using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace Cabinet.Agent.Core.Server;

/// <summary>
/// The cabinet's private key. On Windows it lives in the machine key store,
/// non-exportable (docs/spec/02-security-model.md); nothing here can read it out.
/// </summary>
public interface IAgentKeyStore
{
    /// <summary>A PKCS#10 request for this agent's key, creating the key on first use.</summary>
    string CreateSigningRequestPem();
    /// <summary>The issued certificate joined to this agent's private key, for TLS client authentication.</summary>
    X509Certificate2 WithPrivateKey(string certificatePem);
}

/// <summary>An ECDSA P-256 key held in memory. For tests and Linux runs; the Windows agent uses the machine key store.</summary>
public sealed class InMemoryKeyStore : IAgentKeyStore, IDisposable
{
    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public string CreateSigningRequestPem() =>
        new CertificateRequest("CN=cabinet-agent", _key, HashAlgorithmName.SHA256).CreateSigningRequestPem();

    public X509Certificate2 WithPrivateKey(string certificatePem)
    {
        using var certificate = X509Certificate2.CreateFromPem(certificatePem);
        X509Certificate2 joined = certificate.CopyWithPrivateKey(_key);
        // SslStream on some platforms needs a certificate whose key is not ephemeral; round-trip through PKCS#12 in memory.
        byte[] pfx = joined.Export(X509ContentType.Pkcs12);
        joined.Dispose();
#pragma warning disable SYSLIB0057
        return X509CertificateLoader.LoadPkcs12(pfx, null, X509KeyStorageFlags.Exportable);
#pragma warning restore SYSLIB0057
    }

    public void Dispose() => _key.Dispose();
}

/// <summary>What the agent knows about itself once enrolled.</summary>
public sealed record AgentIdentity(Guid CabinetId, string CertificatePem);

/// <summary>
/// The agent's enrollment state on disk: the issued identity, a pending request
/// ID, and the one-time bootstrap token the installer left (deleted once used).
/// </summary>
public sealed class IdentityStore(string stateDirectory)
{
    private string IdentityPath => Path.Combine(stateDirectory, "identity.json");
    private string RequestPath => Path.Combine(stateDirectory, "enrollment-request.txt");
    public string TokenPath => Path.Combine(stateDirectory, "bootstrap-token");

    public AgentIdentity? LoadIdentity()
    {
        if (!File.Exists(IdentityPath)) return null;
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllBytes(IdentityPath));
        return new AgentIdentity(doc.RootElement.GetProperty("cabinetId").GetGuid(), doc.RootElement.GetProperty("certificatePem").GetString()!);
    }

    public void SaveIdentity(AgentIdentity identity) =>
        AtomicFile.Write(IdentityPath, JsonSerializer.Serialize(new { cabinetId = identity.CabinetId, certificatePem = identity.CertificatePem }));

    public Guid? LoadRequestId() =>
        File.Exists(RequestPath) && Guid.TryParseExact(File.ReadAllText(RequestPath).Trim(), "D", out Guid id) ? id : null;

    public void SaveRequestId(Guid id) => AtomicFile.Write(RequestPath, id.ToString("D"));
    public void ClearRequestId() => File.Delete(RequestPath);

    /// <summary>The token, if the installer left one. Read, never logged.</summary>
    public string? LoadToken()
    {
        if (!File.Exists(TokenPath)) return null;
        string token = File.ReadAllText(TokenPath).Trim();
        return token.Length is >= 32 and <= 128 && token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_') ? token : null;
    }

    public void DeleteToken() => File.Delete(TokenPath);
}

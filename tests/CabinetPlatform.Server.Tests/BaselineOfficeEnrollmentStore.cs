using Microsoft.AspNetCore.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Security;

/// <summary>Single-server, bounded office lab enrollment. Not a fleet identity service.</summary>
public sealed class BaselineOfficeEnrollmentOptions
{
    public bool Enabled { get; set; }
    public string StateFile { get; set; } = "";
    public List<BaselineOfficeEnrollmentToken> Tokens { get; set; } = [];
}

public sealed record BaselineOfficeEnrollmentToken
{
    public string TokenHash { get; init; } = "";
    public DateTimeOffset IssuedUtc { get; init; }
    public DateTimeOffset ExpiresUtc { get; init; }
    public DateTimeOffset DeviceExpiresUtc { get; init; }
}

/// <summary>
/// Stores hashes only. Holds an exclusive process lock for its lifetime. A missing or
/// corrupt journal is a hard failure, never a reset that permits token replay.
/// Removal of a token from configuration revokes its device after server restart.
/// </summary>
public sealed class BaselineOfficeEnrollmentStore : IDisposable
{
    private readonly BaselineOfficeEnrollmentOptions _options;
    private readonly TimeProvider _clock;
    private readonly object _gate = new();
    private readonly FileStream? _lockFile;
    private List<Grant> _grants = [];
    public bool Enabled => _options.Enabled;

    public BaselineOfficeEnrollmentStore(IOptions<BaselineOfficeEnrollmentOptions> options, TimeProvider clock)
    {
        _options = options.Value;
        _clock = clock;
        if (!Enabled) return;
        if (!Path.IsPathFullyQualified(_options.StateFile) || _options.Tokens.Count > 100 ||
            _options.Tokens.Any(t => !IsKey(t.TokenHash) || t.ExpiresUtc <= t.IssuedUtc ||
                t.ExpiresUtc > t.IssuedUtc.AddMinutes(30) || t.DeviceExpiresUtc <= t.ExpiresUtc ||
                t.DeviceExpiresUtc > t.IssuedUtc.AddDays(7)) ||
            _options.Tokens.Select(t => t.TokenHash).Distinct(StringComparer.OrdinalIgnoreCase).Count() != _options.Tokens.Count)
            throw new InvalidOperationException("Invalid bounded office enrollment configuration.");
        _lockFile = new FileStream(_options.StateFile + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        try
        {
            if (new FileInfo(_options.StateFile).Length > 128 * 1024)
                throw new InvalidOperationException("Office enrollment journal exceeds its limit.");
            _grants = JsonSerializer.Deserialize<List<Grant>>(File.ReadAllText(_options.StateFile))
                ?? throw new InvalidOperationException("Office enrollment journal is invalid.");
            if (_grants.Count > 100 || _grants.Any(g => g is null || !IsKey(g.TokenHash) || !IsKey(g.KeyHash) || !IsMachineId(g.MachineId)) ||
                _grants.Select(g => g.TokenHash).Distinct(StringComparer.OrdinalIgnoreCase).Count() != _grants.Count ||
                _grants.Select(g => g.MachineId).Distinct(StringComparer.Ordinal).Count() != _grants.Count)
                throw new InvalidOperationException("Office enrollment journal is invalid.");
        }
        catch { _lockFile.Dispose(); throw; }
    }

    public bool Redeem(string token, string machineId, string deviceKey, bool allowNewIdentity = true)
    {
        if (!Enabled || !IsKey(token) || !IsKey(deviceKey) || !IsMachineId(machineId)) return false;
        var tokenHash = Hash(token);
        var keyHash = Hash(deviceKey);
        lock (_gate)
        {
            var issued = _options.Tokens.SingleOrDefault(t => EqualsHash(t.TokenHash, tokenHash));
            var now = _clock.GetUtcNow();
            if (issued is null || now < issued.IssuedUtc || now >= issued.DeviceExpiresUtc) return false;
            var prior = _grants.SingleOrDefault(g => EqualsHash(g.TokenHash, tokenHash));
            // Exactly the same retry remains safe even if the initial response was lost.
            // Neither token alone nor a changed machine/key can recover a device credential.
            if (prior is not null) return prior.MachineId == machineId && EqualsHash(prior.KeyHash, keyHash);
            if (!allowNewIdentity || now >= issued.ExpiresUtc || _grants.Count >= 100 || _grants.Any(g => g.MachineId == machineId)) return false;
            var next = new List<Grant>(_grants) { new(tokenHash, machineId, keyHash) };
            Persist(next); // Commit before making credentials usable or returning success.
            _grants = next;
            return true;
        }
    }

    public AgentIdentity Authenticate(HttpContext context, AgentAuthOptions headers)
    {
        if (!Enabled || !context.Request.Headers.TryGetValue(headers.MachineIdHeaderName, out var machine) ||
            machine.Count != 1 || !IsMachineId(machine[0]) ||
            !context.Request.Headers.TryGetValue(headers.HeaderName, out var key) || key.Count != 1 || !IsKey(key[0]))
            return AgentIdentity.Fail("Office device credential required.");
        lock (_gate)
        {
            var grant = _grants.SingleOrDefault(g => g.MachineId == machine[0]);
            var token = grant is null ? null : _options.Tokens.SingleOrDefault(t => EqualsHash(t.TokenHash, grant.TokenHash));
            if (grant is null || token is null || _clock.GetUtcNow() < token.IssuedUtc ||
                _clock.GetUtcNow() >= token.DeviceExpiresUtc || !EqualsHash(grant.KeyHash, Hash(key[0]!)))
                return AgentIdentity.Fail("Office device credential invalid.");
            return AgentIdentity.Success(grant.MachineId);
        }
    }

    private void Persist(List<Grant> grants)
    {
        var temporary = _options.StateFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                       4096, FileOptions.WriteThrough))
            {
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                JsonSerializer.Serialize(stream, grants);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, _options.StateFile, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static bool IsMachineId(string? value) => value is { Length: > 0 and <= 128 } &&
        value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');
    private static bool IsKey(string? value) => value is { Length: 64 } && value.All(Uri.IsHexDigit);
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static bool EqualsHash(string a, string b) => CryptographicOperations.FixedTimeEquals(
        Convert.FromHexString(a), Convert.FromHexString(b));
    public void Dispose() => _lockFile?.Dispose();
    public sealed record Grant(string TokenHash, string MachineId, string KeyHash);
}

/// <summary>Office mode never falls back to the legacy shared fleet secret.</summary>
public sealed class BaselineOfficeAgentAuthenticator(BaselineOfficeEnrollmentStore store, IOptions<AgentAuthOptions> options) : IAgentAuthenticator
{
    public AgentIdentity Authenticate(HttpContext context) => store.Authenticate(context, options.Value);
}

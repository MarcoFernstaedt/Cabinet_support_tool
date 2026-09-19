using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Transport;

/// <summary>
/// Office-only bootstrap using an administrator-protected one-device token file.
/// Persists a newly generated key before exchange so a lost response is retryable.
/// The journal and token directory must be writable only by SYSTEM/Administrators.
/// </summary>
public sealed class OfficeAgentCredentialProvider : IAgentCredentialProvider, IDisposable
{
    public const string HttpClientName = "cabinet-office-enrollment";
    private readonly IHttpClientFactory _clients;
    private readonly IMachineIdentityProvider _identity;
    private readonly string _provisionFile;
    private readonly string _stateFile;
    private readonly string _endpoint;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private FileStream? _lockFile;
    private DeviceState? _state;

    public OfficeAgentCredentialProvider(IHttpClientFactory clients, IMachineIdentityProvider identity, IOptions<AgentOptions> options)
    {
        _clients = clients;
        _identity = identity;
        _provisionFile = Path.GetFullPath(options.Value.OfficeEnrollmentFile!, AppContext.BaseDirectory);
        _stateFile = _provisionFile + ".device";
        _endpoint = NormalizeEndpoint(options.Value.ServerBaseUrl);
    }

    public string? GetAgentKey() => _state is { Confirmed: true } ? _state.DeviceKey : null;

    public void ValidateDestination(Uri? destination)
    {
        if (destination is null || !destination.IsAbsoluteUri ||
            destination.Scheme != Uri.UriSchemeHttps || destination.GetLeftPart(UriPartial.Authority) + "/" != _endpoint ||
            !string.IsNullOrEmpty(destination.UserInfo))
            throw new InvalidOperationException("Office credentials cannot be sent to another endpoint.");
    }

    public async Task<string> EnsureKeyAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _lockFile ??= new FileStream(_stateFile + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            if (_state is null && File.Exists(_stateFile))
                _state = Read<DeviceState>(_stateFile);
            if (_state is not null && (_state.ServerBaseUrl != _endpoint || _state.MachineId != _identity.GetMachineId() ||
                !IsKey(_state.DeviceKey)))
                throw new InvalidOperationException("Office credential journal does not match this machine and endpoint.");
            if (_state is { Confirmed: true })
            {
                if (File.Exists(_provisionFile)) File.Delete(_provisionFile);
                return _state.DeviceKey;
            }

            var provision = Read<Provisioning>(_provisionFile);
            if (NormalizeEndpoint(provision.ServerBaseUrl) != _endpoint || !IsKey(provision.Token))
                throw new InvalidOperationException("Office provisioning file is invalid or belongs to another endpoint.");
            if (_state is null)
            {
                var next = new DeviceState(_endpoint, _identity.GetMachineId(),
                    Convert.ToHexString(RandomNumberGenerator.GetBytes(32)), false);
                Persist(next);
                _state = next;
            }
            using var client = _clients.CreateClient(HttpClientName);
            ValidateDestination(client.BaseAddress);
            using var response = await client.PostAsJsonAsync("api/office/enroll", new
            {
                provision.Token,
                _state.MachineId,
                _state.DeviceKey,
            }, cancellationToken).ConfigureAwait(false);
            if (response.StatusCode != HttpStatusCode.NoContent)
                throw new HttpRequestException("Office enrollment was not accepted. No shared-key fallback is permitted.", null, response.StatusCode);
            var confirmed = _state with { Confirmed = true };
            Persist(confirmed);
            _state = confirmed;
            File.Delete(_provisionFile);
            return confirmed.DeviceKey;
        }
        finally { _gate.Release(); }
    }

    private void Persist(DeviceState state)
    {
        var temporary = _stateFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                JsonSerializer.Serialize(stream, state);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, _stateFile, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static T Read<T>(string path)
    {
        if (new FileInfo(path).Length > 4096) throw new InvalidOperationException("Office credential file exceeds its limit.");
        return JsonSerializer.Deserialize<T>(File.ReadAllText(path))
            ?? throw new InvalidOperationException("Office credential file is invalid.");
    }

    private static bool IsKey(string? value) => value is { Length: 64 } && value.All(Uri.IsHexDigit);
    private static string NormalizeEndpoint(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != "/")
            throw new InvalidOperationException("Office endpoint must be an HTTPS origin without credentials, path, query or fragment.");
        return uri.AbsoluteUri;
    }

    public void Dispose() { _lockFile?.Dispose(); _gate.Dispose(); }
    private sealed record Provisioning(string ServerBaseUrl, string Token);
    private sealed record DeviceState(string ServerBaseUrl, string MachineId, string DeviceKey, bool Confirmed);
}

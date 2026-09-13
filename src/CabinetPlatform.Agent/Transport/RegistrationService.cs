using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Contracts.Auth;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Transport;

/// <summary>
/// Enrols the cabinet and waits to be approved.
/// </summary>
/// <remarks>
/// Approval is a human decision made on the server. The agent's whole part in
/// it is to say who it is, persist what it is told, and keep asking politely
/// until somebody says yes. It never assumes approval, never retries its way
/// past a refusal, and reports nothing diagnostic in the meantime.
/// </remarks>
public sealed class RegistrationService
{
    private readonly IServerClient _client;
    private readonly IAgentStateStore _stateStore;
    private readonly IMachineIdentityProvider _identity;
    private readonly IWmiRepository _wmi;
    private readonly IClock _clock;
    private readonly ILogger<RegistrationService> _logger;

    public RegistrationService(
        IServerClient client,
        IAgentStateStore stateStore,
        IMachineIdentityProvider identity,
        IWmiRepository wmi,
        IClock clock,
        ILogger<RegistrationService> logger)
    {
        _client = client;
        _stateStore = stateStore;
        _identity = identity;
        _wmi = wmi;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>
    /// Registers if this cabinet has no assigned id yet.
    /// </summary>
    /// <returns>True when the cabinet is approved and may report normally.</returns>
    public async Task<bool> EnsureRegisteredAsync(CancellationToken cancellationToken)
    {
        var state = _stateStore.Load();

        if (state.IsApproved && state.CabinetId != Guid.Empty)
        {
            return true;
        }

        var request = new RegistrationRequest
        {
            MachineId = _identity.GetMachineId(),

            // Hostname is reported because support staff need something human
            // to recognise a pending cabinet by. It is never the identity.
            Hostname = ReadHostname(),
            OsVersion = ReadOsVersion(),
            AgentVersion = CheckInBuilder.AgentVersion,
        };

        var response = await _client.RegisterAsync(request, cancellationToken).ConfigureAwait(false);

        if (response is null)
        {
            _stateStore.Update(current => current with { LastRegistrationAttemptUtc = _clock.UtcNow });
            return false;
        }

        var updated = _stateStore.Update(current => current with
        {
            RegistrationStatus = response.Status,
            // A registration response is authoritative only for its own identity.
            // Never combine a fresh approval with an id retained from older state.
            CabinetId = response.Status == RegistrationStatus.Approved &&
                        response.CabinetId is { } id && id != Guid.Empty ? id : null,
            LastRegistrationAttemptUtc = _clock.UtcNow,
        });

        switch (response.Status)
        {
            case RegistrationStatus.Approved when updated.CabinetId is not null:
                _logger.LogInformation(
                    "This cabinet has been approved and assigned {CabinetId}.",
                    updated.CabinetId);
                return true;

            case RegistrationStatus.Approved:
                // Approved without an id is a server-side inconsistency. The
                // agent will not start reporting on the strength of it.
                _logger.LogWarning(
                    "The server reported this cabinet approved but returned no cabinet id. " +
                    "The agent will keep reporting identity only until it does.");
                return false;

            case RegistrationStatus.Rejected:
                _logger.LogWarning(
                    "The server rejected this cabinet's registration. " +
                    "It will keep asking, but retries cannot overturn this decision.");
                return false;

            default:
                _logger.LogInformation("Registration is pending approval on the server.");
                return false;
        }
    }

    /// <summary>
    /// Records approval learned from a check-in response.
    /// </summary>
    public void RecordApproval(Guid cabinetId)
    {
        if (cabinetId == Guid.Empty)
        {
            _logger.LogWarning("The server returned an empty cabinet identity. Approval was not recorded.");
            RecordNotRegistered();
            return;
        }

        var state = _stateStore.Load();
        if (state.CabinetId == cabinetId && state.RegistrationStatus == RegistrationStatus.Approved)
        {
            return;
        }

        _stateStore.Update(current => current with
        {
            CabinetId = cabinetId,
            RegistrationStatus = RegistrationStatus.Approved,
        });

        _logger.LogInformation("This cabinet has been approved and assigned {CabinetId}.", cabinetId);
    }

    /// <summary>Clears approval when the server no longer recognises this cabinet.</summary>
    public void RecordNotRegistered()
    {
        var state = _stateStore.Load();
        if (state.CabinetId is null && state.RegistrationStatus is null)
        {
            return;
        }

        _logger.LogWarning(
            "The server no longer recognises this cabinet. The agent will register again " +
            "and report identity only until it is approved.");

        _stateStore.Update(current => current with
        {
            CabinetId = null,
            RegistrationStatus = null,
        });
    }

    private string ReadHostname()
    {
        try
        {
            var name = _wmi.Query(WmiScopes.CimV2, "SELECT Name FROM Win32_ComputerSystem")
                .FirstOrDefault()?.GetString("Name");

            return string.IsNullOrWhiteSpace(name) ? Environment.MachineName : name;
        }
        catch (Exception e)
        {
            _logger.LogDebug(e, "The hostname could not be read from WMI.");
            return Environment.MachineName;
        }
    }

    private string ReadOsVersion()
    {
        try
        {
            var row = _wmi.Query(WmiScopes.CimV2, "SELECT Caption, Version FROM Win32_OperatingSystem")
                .FirstOrDefault();

            var caption = row?.GetString("Caption");
            var version = row?.GetString("Version");

            if (caption is not null && version is not null)
            {
                return $"{caption} ({version})";
            }

            return caption ?? version ?? Environment.OSVersion.VersionString;
        }
        catch (Exception e)
        {
            _logger.LogDebug(e, "The OS version could not be read from WMI.");
            return Environment.OSVersion.VersionString;
        }
    }
}

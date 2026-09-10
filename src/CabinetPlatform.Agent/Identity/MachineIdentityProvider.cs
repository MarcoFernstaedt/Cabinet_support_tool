using System.Security.Cryptography;
using System.Text;
using CabinetPlatform.Agent.Platform.Wmi;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Identity;

/// <summary>
/// Derives the agent's identity from hardware.
/// </summary>
/// <remarks>
/// <para>
/// Hostname is never used. Cabinet hostnames get renamed during clinic
/// re-imaging and are routinely duplicated across sites, so an identity built
/// on one would silently merge two cabinets' histories — in a DEA-audited
/// system that is a records integrity problem, not an inconvenience.
/// </para>
/// <para>
/// The source is <c>Win32_ComputerSystemProduct.UUID</c>, falling back to the
/// motherboard serial. Whichever is used, it is hashed before it leaves the
/// machine: the server needs a stable identifier, not the hardware serial
/// itself.
/// </para>
/// </remarks>
public sealed class MachineIdentityProvider : IMachineIdentityProvider
{
    /// <summary>
    /// UUIDs some OEMs burn into every unit off a line. They are not unique and
    /// must never become an identity.
    /// </summary>
    private static readonly HashSet<string> NonUniqueUuids = new(StringComparer.OrdinalIgnoreCase)
    {
        "00000000-0000-0000-0000-000000000000",
        "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
        "03000200-0400-0500-0006-000700080009",
    };

    private readonly IWmiRepository _wmi;
    private readonly IAgentStateStore _stateStore;
    private readonly ILogger<MachineIdentityProvider> _logger;
    private readonly object _gate = new();
    private string? _cached;

    public MachineIdentityProvider(
        IWmiRepository wmi,
        IAgentStateStore stateStore,
        ILogger<MachineIdentityProvider> logger)
    {
        _wmi = wmi;
        _stateStore = stateStore;
        _logger = logger;
    }

    public string GetMachineId()
    {
        lock (_gate)
        {
            if (_cached is not null)
            {
                return _cached;
            }

            // A persisted id wins over a freshly derived one. If a motherboard
            // is replaced under warranty the cabinet keeps its identity and its
            // audit history rather than appearing as a new machine.
            var persisted = _stateStore.Load().MachineId;
            if (!string.IsNullOrWhiteSpace(persisted))
            {
                _cached = persisted;
                return _cached;
            }

            var derived = Hash(DeriveHardwareValue());
            _stateStore.Update(state => state with { MachineId = derived });
            _cached = derived;

            _logger.LogInformation("Derived and persisted machine id {MachineId}.", derived);
            return derived;
        }
    }

    private string DeriveHardwareValue()
    {
        var uuid = SafeQuerySingle(WmiScopes.CimV2, "SELECT UUID FROM Win32_ComputerSystemProduct", "UUID");
        if (!string.IsNullOrWhiteSpace(uuid) && !NonUniqueUuids.Contains(uuid))
        {
            return $"uuid:{uuid}";
        }

        _logger.LogWarning(
            "Win32_ComputerSystemProduct.UUID was absent or a known non-unique value; " +
            "falling back to the motherboard serial.");

        var boardSerial = SafeQuerySingle(
            WmiScopes.CimV2,
            "SELECT SerialNumber FROM Win32_BaseBoard",
            "SerialNumber");

        if (!string.IsNullOrWhiteSpace(boardSerial) &&
            !boardSerial.Equals("To be filled by O.E.M.", StringComparison.OrdinalIgnoreCase) &&
            !boardSerial.Equals("Default string", StringComparison.OrdinalIgnoreCase))
        {
            return $"baseboard:{boardSerial}";
        }

        // Both hardware sources failed. A random id persisted locally is still
        // stable for this installation and still not a hostname; it is logged
        // loudly because it means hardware identity is unavailable.
        _logger.LogError(
            "Neither a usable system UUID nor a motherboard serial was readable. " +
            "Falling back to a locally generated identity, which will not survive a rebuild.");

        return $"generated:{Guid.NewGuid():D}";
    }

    private string? SafeQuerySingle(string scope, string query, string property)
    {
        try
        {
            return _wmi.Query(scope, query).FirstOrDefault()?.GetString(property);
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "Identity query failed: {Query}", query);
            return null;
        }
    }

    internal static string Hash(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}

using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Telemetry;

/// <summary>
/// Which tier of check-in a payload belongs to.
/// </summary>
/// <remarks>
/// <para>
/// The tier decides which sections of <see cref="CheckInPayload"/> the agent
/// populates and what the server persists. The payload contract itself is the
/// same for every tier: one shape, differently filled.
/// </para>
/// <para>
/// The tier is carried by the route rather than by the payload, so that a
/// cabinet cannot ask for its heavy sections to be stored simply by claiming a
/// tier. The server persists according to the endpoint the request arrived on.
/// </para>
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CheckInTier
{
    /// <summary>
    /// The small fixed sample, every few minutes. Populates
    /// <see cref="CheckInPayload.System"/> and
    /// <see cref="CheckInPayload.Performance"/> lightly, and
    /// <see cref="CheckInPayload.Disks"/> for free space only — no SMART, no
    /// services, no software inventory, no network detail, no processes.
    /// </summary>
    Heartbeat = 1,

    /// <summary>
    /// The slow sample, every six hours and whenever something changes.
    /// Populates services, installed software, network configuration, update
    /// policy and SMART. Inventory is stored only when its content hash
    /// differs from the version in force; SMART is stored every time.
    /// </summary>
    Full = 2,
}

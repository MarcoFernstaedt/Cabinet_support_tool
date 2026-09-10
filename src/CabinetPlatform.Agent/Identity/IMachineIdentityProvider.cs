namespace CabinetPlatform.Agent.Identity;

/// <summary>
/// Supplies the agent's stable identity.
/// </summary>
public interface IMachineIdentityProvider
{
    /// <summary>
    /// The machine id sent to the server: a SHA-256 hash of a hardware-derived
    /// value, stable across restarts and reinstalls of the agent.
    /// </summary>
    string GetMachineId();
}

namespace CabinetPlatform.Agent.Platform;

/// <summary>Named HTTP clients the agent uses.</summary>
public static class AgentHttpClients
{
    /// <summary>Carries registration, check-ins and action results.</summary>
    public const string Server = "cabinet-server";

    /// <summary>
    /// The reachability probe. It is separate so its short timeout cannot
    /// shorten a real check-in, and so a probe failure never disturbs the
    /// connection pool the check-in is using.
    /// </summary>
    public const string Probe = "cabinet-server-probe";
}

using System.Threading.RateLimiting;
using CabinetPlatform.Server.Configuration;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Security;

public static class RateLimitPolicies
{
    public const string Login = "login";
    public const string AgentRegister = "agent-register";
    public const string AgentCheckIn = "agent-checkin";

    /// <summary>
    /// Partition keys are derived server-side. Login partitions by remote IP;
    /// agent endpoints partition by the machine identity the authenticator
    /// established, so one noisy cabinet cannot starve the rest of a clinic.
    /// </summary>
    public static void Configure(
        RateLimiterOptions options,
        LoginSecurityOptions login,
        AgentIngestOptions agent)
    {
        options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

        options.AddPolicy(Login, context => RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = login.RateLimitPermitPerWindow,
                Window = TimeSpan.FromSeconds(login.RateLimitWindowSeconds),
                QueueLimit = 0,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst
            }));

        options.AddPolicy(AgentRegister, context => RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: AgentPartitionKey(context),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = agent.RegisterPermitPerWindow,
                Window = TimeSpan.FromSeconds(agent.RegisterWindowSeconds),
                QueueLimit = 0,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst
            }));

        options.AddPolicy(AgentCheckIn, context => RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: AgentPartitionKey(context),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = agent.CheckInPermitPerWindow,
                Window = TimeSpan.FromSeconds(agent.CheckInWindowSeconds),
                QueueLimit = 0,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst
            }));
    }

    /// <summary>
    /// Prefers the authenticated machine id and falls back to the presented
    /// header, then the remote address. The header is untrusted for identity —
    /// it is only ever a partition key here, never an authorization input.
    /// </summary>
    private static string AgentPartitionKey(HttpContext context)
    {
        string? machineId = context.User.GetAgentMachineId();

        if (!string.IsNullOrWhiteSpace(machineId))
        {
            return $"machine:{machineId}";
        }

        AgentAuthOptions options = context.RequestServices
            .GetRequiredService<IOptions<AgentAuthOptions>>().Value;

        if (context.Request.Headers.TryGetValue(options.MachineIdHeaderName, out var presented) &&
            presented.Count == 1 &&
            !string.IsNullOrWhiteSpace(presented[0]))
        {
            string value = presented[0]!.Trim();
            return $"claimed:{(value.Length > 128 ? value[..128] : value)}";
        }

        return $"ip:{context.Connection.RemoteIpAddress?.ToString() ?? "unknown"}";
    }
}

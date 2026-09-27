using System.Text.Json;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>Read-only firewall inspection. No target, script, port, or rule operands are accepted.</summary>
public sealed class InspectFirewallExecutor(FirewallReader reader) : IActionExecutor
{
    public ActionName Action => ActionName.InspectFirewall;

    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, Array.Empty<string>(), out string failure))
            return Task.FromResult(ActionOutcome.Denied(failure));
        var result = reader.Read(cancellationToken);
        return Task.FromResult(ActionOutcome.Collected(
            $"Firewall inspection: {result.Status}. {result.Rules.Count} rule metadata rows; no changes made.",
            JsonSerializer.Serialize(result, AgentJson.SerializerOptions)));
    }
}

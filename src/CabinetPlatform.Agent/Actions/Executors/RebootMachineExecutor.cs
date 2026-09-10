using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// Restarts the cabinet.
/// </summary>
/// <remarks>
/// <para>
/// This is the most disruptive thing the agent can do, and the only one that
/// can interrupt a person mid-task. A veterinary or dental cabinet is a
/// dispensing station: somebody standing at it may be part-way through pulling
/// a controlled substance against a patient record. So the executor refuses
/// while anybody is signed in, unless a supervisor has explicitly said to
/// proceed anyway.
/// </para>
/// <para>
/// The refusal is a <see cref="ActionStatus.Denied"/>, not a failure: nothing
/// went wrong, the agent declined. Support then either waits or comes back with
/// the override, and either way the decision is a person's and is recorded.
/// </para>
/// </remarks>
public sealed class RebootMachineExecutor : IActionExecutor
{
    private static readonly string[] PermittedParameters = { ActionParameters.SupervisorOverride };

    private readonly LogonSessionReader _logons;
    private readonly INativeSystemGateway _native;
    private readonly ActionOptions _options;
    private readonly ILogger<RebootMachineExecutor> _logger;

    public RebootMachineExecutor(
        LogonSessionReader logons,
        INativeSystemGateway native,
        IOptions<AgentOptions> options,
        ILogger<RebootMachineExecutor> logger)
    {
        _logons = logons;
        _native = native;
        _options = options.Value.Actions;
        _logger = logger;
    }

    public ActionName Action => ActionName.RebootMachine;

    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, PermittedParameters, out var unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        var supervisorOverride = ActionParameters.GetBooleanFlag(request, ActionParameters.SupervisorOverride);

        IReadOnlyList<string> loggedOnUsers;
        try
        {
            loggedOnUsers = _logons.GetInteractiveUsers();
        }
        catch (Exception e)
        {
            // The guard could not be evaluated. Rebooting anyway would be
            // assuming the cabinet is unattended on no evidence, so it is not
            // done: an unnecessary refusal costs a support call, and the
            // alternative costs an interrupted dispense.
            _logger.LogError(e, "Could not determine whether anybody is logged on; refusing the reboot.");

            return Task.FromResult(ActionOutcome.Denied(
                "The agent could not determine whether anybody is signed in to this cabinet, " +
                "so it did not restart it."));
        }

        if (loggedOnUsers.Count > 0 && !supervisorOverride)
        {
            _logger.LogWarning(
                "Refusing to restart: {UserCount} interactive session(s) are open ({Users}). " +
                "A supervisor override is required to restart an occupied cabinet.",
                loggedOnUsers.Count,
                string.Join(", ", loggedOnUsers));

            return Task.FromResult(ActionOutcome.Denied(
                $"{loggedOnUsers.Count} user(s) are signed in to this cabinet ({string.Join(", ", loggedOnUsers)}). " +
                "The agent does not restart an occupied cabinet without an explicit supervisor override."));
        }

        if (loggedOnUsers.Count > 0)
        {
            // Recorded prominently: this is a person deciding to interrupt
            // another person, and the audit trail should say so plainly.
            _logger.LogWarning(
                "Restarting an occupied cabinet under a supervisor override from {RequestedBy}. " +
                "Signed in: {Users}. Reason: {Reason}",
                request.RequestedByUserId,
                string.Join(", ", loggedOnUsers),
                request.Reason);
        }

        var delay = TimeSpan.FromSeconds(_options.RebootDelaySeconds);

        try
        {
            _native.InitiateRestart(
                delay,
                $"This cabinet will restart in {delay.TotalSeconds:F0} seconds for scheduled IT maintenance. " +
                $"Reason: {request.Reason}");
        }
        catch (Exception e)
        {
            _logger.LogError(e, "The restart could not be initiated.");
            return Task.FromResult(ActionOutcome.Failed($"The restart could not be initiated. {e.Message}"));
        }

        var note = loggedOnUsers.Count > 0
            ? $" A supervisor override was used while {loggedOnUsers.Count} user(s) were signed in."
            : " No interactive users were signed in.";

        return Task.FromResult(ActionOutcome.Succeeded(
            $"A restart has been scheduled in {delay.TotalSeconds:F0} seconds.{note}"));
    }
}

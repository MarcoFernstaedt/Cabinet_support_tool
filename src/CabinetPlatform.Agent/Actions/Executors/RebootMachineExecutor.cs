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
    private static readonly string[] PermittedParameters = { ActionParameterKeys.DelaySeconds };

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

        // There is deliberately no "override" parameter. A Supervisor's waiver
        // of the safety interlock is a server-side decision recorded on the
        // request; letting it travel as a parameter would make the agent's last
        // line of defence something the caller could simply assert.
        //
        // The agent therefore re-checks for itself whether anybody is signed in
        // and refuses if they are, whatever the server decided.

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

        if (loggedOnUsers.Count > 0)
        {
            _logger.LogWarning(
                "Refusing to restart: {UserCount} interactive session(s) are open ({Users}).",
                loggedOnUsers.Count,
                string.Join(", ", loggedOnUsers));

            return Task.FromResult(ActionOutcome.Denied(
                $"{loggedOnUsers.Count} user(s) are signed in to this cabinet ({string.Join(", ", loggedOnUsers)}). " +
                "The agent does not restart an occupied cabinet. The server's own check uses the last " +
                "check-in, which can be minutes old; this one is what the cabinet sees now."));
        }

        // The caller may ask for a longer warning than the agent's default, up
        // to the ceiling the server's validator enforces. It may not ask for a
        // shorter one: the floor is this agent's, so a request cannot shorten
        // the notice the people at the cabinet get.
        TimeSpan delay = TimeSpan.FromSeconds(_options.RebootDelaySeconds);

        if (ActionParameters.TryGetOptionalSeconds(
                request, ActionParameterKeys.DelaySeconds, out TimeSpan requested) &&
            requested > delay)
        {
            delay = requested;
        }

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

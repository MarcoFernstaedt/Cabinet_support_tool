using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// Shared behaviour for the three service actions.
/// </summary>
/// <remarks>
/// The target service is checked against the agent's own allow-list here,
/// separately from the server's check. Everything below this point assumes the
/// name has already been validated, so the check happens once, in one place,
/// before any of it runs.
/// </remarks>
public abstract class ServiceExecutorBase : IActionExecutor
{
    private readonly ServiceNameAllowList _allowList;
    private readonly ActionOptions _options;

    /// <summary>Creates the executor.</summary>
    /// <param name="services">Drives the service control manager.</param>
    /// <param name="allowList">The agent's own service allow-list.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    protected ServiceExecutorBase(
        IServiceControlGateway services,
        ServiceNameAllowList allowList,
        IOptions<AgentOptions> options,
        ILogger logger)
    {
        Services = services;
        Logger = logger;
        _allowList = allowList;
        _options = options.Value.Actions;
    }

    /// <summary>Drives the service control manager.</summary>
    protected IServiceControlGateway Services { get; }

    /// <summary>Diagnostic log.</summary>
    protected ILogger Logger { get; }

    /// <inheritdoc />
    public abstract ActionName Action { get; }

    /// <summary>
    /// The parameter keys this action defines. The service name for all of
    /// them; the start-type action adds one more.
    /// </summary>
    protected virtual IReadOnlyList<string> PermittedParameterKeys { get; } =
        new[] { ActionParameterKeys.ServiceName };

    /// <summary>
    /// How long a single start or stop may take. Deliberately shorter than the
    /// dispatcher's timeout so the service control manager's own wait gives up
    /// first and the executor can report which half was slow.
    /// </summary>
    protected TimeSpan ServiceTimeout => TimeSpan.FromSeconds(Math.Max(5, _options.DefaultTimeoutSeconds / 2));

    /// <inheritdoc />
    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, PermittedParameterKeys, out var unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        if (!ActionParameters.TryGetRequiredString(
                request,
                ActionParameterKeys.ServiceName,
                out var serviceName,
                out var missingFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(missingFailure));
        }

        if (!_allowList.IsAllowed(serviceName, out var notAllowedFailure))
        {
            Logger.LogWarning(
                "Action {RequestId} asked to {Action} the service '{ServiceName}', which this agent will not touch: " +
                "{Reason}",
                request.Id,
                Action,
                serviceName,
                notAllowedFailure);

            return Task.FromResult(ActionOutcome.Denied(notAllowedFailure));
        }

        try
        {
            return Task.FromResult(Perform(request, serviceName, cancellationToken));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Logger.LogWarning(e, "The action on service '{ServiceName}' failed.", serviceName);

            return Task.FromResult(ActionOutcome.Failed(
                $"The service '{serviceName}' could not be changed. {e.Message}"));
        }
    }

    /// <summary>Performs the action, with the service name already proved.</summary>
    /// <param name="request">The request, for any further parameters.</param>
    /// <param name="serviceName">The allow-listed service name.</param>
    /// <param name="cancellationToken">Cancels the action.</param>
    protected abstract ActionOutcome Perform(
        ActionRequestDto request, string serviceName, CancellationToken cancellationToken);

    /// <summary>Reports the service's state after a transition.</summary>
    /// <param name="serviceName">The service.</param>
    /// <param name="verb">What was done to it.</param>
    protected ActionOutcome Describe(string serviceName, string verb)
    {
        var state = ReadState(serviceName);
        return ActionOutcome.Succeeded($"The service '{serviceName}' was {verb}. It is now {state}.");
    }

    private ServiceState ReadState(string serviceName)
    {
        try
        {
            return Services.GetState(serviceName);
        }
        catch (Exception e)
        {
            // The transition succeeded; only the confirming read failed.
            Logger.LogDebug(e, "The state of '{ServiceName}' could not be read after the change.", serviceName);
            return ServiceState.Unknown;
        }
    }
}

/// <summary>Stops and then starts a named service.</summary>
public sealed class RestartServiceExecutor : ServiceExecutorBase
{
    public RestartServiceExecutor(
        IServiceControlGateway services,
        ServiceNameAllowList allowList,
        IOptions<AgentOptions> options,
        ILogger<RestartServiceExecutor> logger)
        : base(services, allowList, options, logger)
    {
    }

    public override ActionName Action => ActionName.RestartService;

    protected override ActionOutcome Perform(
        ActionRequestDto request, string serviceName, CancellationToken cancellationToken)
    {
        Services.Stop(serviceName, ServiceTimeout);

        cancellationToken.ThrowIfCancellationRequested();

        Services.Start(serviceName, ServiceTimeout);

        return Describe(serviceName, "restarted");
    }
}

/// <summary>Starts a named service.</summary>
public sealed class StartServiceExecutor : ServiceExecutorBase
{
    public StartServiceExecutor(
        IServiceControlGateway services,
        ServiceNameAllowList allowList,
        IOptions<AgentOptions> options,
        ILogger<StartServiceExecutor> logger)
        : base(services, allowList, options, logger)
    {
    }

    public override ActionName Action => ActionName.StartService;

    protected override ActionOutcome Perform(
        ActionRequestDto request, string serviceName, CancellationToken cancellationToken)
    {
        Services.Start(serviceName, ServiceTimeout);
        return Describe(serviceName, "started");
    }
}

/// <summary>Stops a named service.</summary>
public sealed class StopServiceExecutor : ServiceExecutorBase
{
    public StopServiceExecutor(
        IServiceControlGateway services,
        ServiceNameAllowList allowList,
        IOptions<AgentOptions> options,
        ILogger<StopServiceExecutor> logger)
        : base(services, allowList, options, logger)
    {
    }

    public override ActionName Action => ActionName.StopService;

    protected override ActionOutcome Perform(
        ActionRequestDto request, string serviceName, CancellationToken cancellationToken)
    {
        Services.Stop(serviceName, ServiceTimeout);
        return Describe(serviceName, "stopped");
    }
}

/// <summary>
/// Changes an allow-listed service's start type.
/// </summary>
/// <remarks>
/// Needs a second person because the consequence is delayed and invisible: a
/// service left Disabled looks fine until the next reboot, at which point a
/// cabinet comes back without its dispensing service and nobody connects the
/// two events.
/// </remarks>
public sealed class SetServiceStartTypeExecutor : ServiceExecutorBase
{
    /// <summary>Creates the executor.</summary>
    /// <param name="services">Drives the service control manager.</param>
    /// <param name="allowList">The agent's own service allow-list.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    public SetServiceStartTypeExecutor(
        IServiceControlGateway services,
        ServiceNameAllowList allowList,
        IOptions<AgentOptions> options,
        ILogger<SetServiceStartTypeExecutor> logger)
        : base(services, allowList, options, logger)
    {
    }

    /// <inheritdoc />
    public override ActionName Action => ActionName.SetServiceStartType;

    /// <inheritdoc />
    protected override IReadOnlyList<string> PermittedParameterKeys { get; } = new[]
    {
        ActionParameterKeys.ServiceName,
        ActionParameterKeys.StartType,
    };

    /// <inheritdoc />
    protected override ActionOutcome Perform(
        ActionRequestDto request, string serviceName, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.StartType, out string raw, out string missing))
        {
            return ActionOutcome.Denied(missing);
        }

        if (!Enum.TryParse(raw, ignoreCase: true, out ServiceStartType startType))
        {
            return ActionOutcome.Denied($"'{raw}' is not a service start type.");
        }

        // Re-checked here as well as on the server. Boot and System are driver
        // load orders: setting an ordinary service to one does not make it
        // start earlier, it makes the machine fail to boot.
        if (startType is ServiceStartType.Boot or ServiceStartType.System or ServiceStartType.Unknown)
        {
            return ActionOutcome.Denied(
                $"'{startType}' is a driver load order, not a start type this agent will set. " +
                "Use Automatic, AutomaticDelayed, Manual or Disabled.");
        }

        ServiceStartType previous = ReadStartType(serviceName);

        Services.SetStartType(serviceName, startType);

        Logger.LogInformation(
            "The start type of '{ServiceName}' was changed from {Previous} to {StartType}.",
            serviceName,
            previous,
            startType);

        string note = startType == ServiceStartType.Disabled
            ? " It will not start at the next reboot until the start type is changed back."
            : string.Empty;

        return ActionOutcome.Succeeded(
            $"The start type of '{serviceName}' was changed from {previous} to {startType}.{note}");
    }

    private ServiceStartType ReadStartType(string serviceName)
    {
        try
        {
            return Services.GetStartType(serviceName);
        }
        catch (Exception e)
        {
            // Only the before-reading failed. The change itself is still worth
            // attempting, and reporting Unknown is the honest answer.
            Logger.LogDebug(e, "The start type of '{ServiceName}' could not be read first.", serviceName);
            return ServiceStartType.Unknown;
        }
    }
}

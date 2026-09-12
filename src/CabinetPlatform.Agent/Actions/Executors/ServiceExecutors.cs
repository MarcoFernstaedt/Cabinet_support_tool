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
    private static readonly string[] PermittedParameters = { ActionParameterKeys.ServiceName };

    private readonly ServiceNameAllowList _allowList;
    private readonly ActionOptions _options;

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

    protected IServiceControlGateway Services { get; }

    protected ILogger Logger { get; }

    public abstract ActionName Action { get; }

    /// <summary>
    /// How long a single start or stop may take. Deliberately shorter than the
    /// dispatcher's timeout so the service control manager's own wait gives up
    /// first and the executor can report which half was slow.
    /// </summary>
    protected TimeSpan ServiceTimeout => TimeSpan.FromSeconds(Math.Max(5, _options.DefaultTimeoutSeconds / 2));

    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, PermittedParameters, out var unknownFailure))
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

        return Task.FromResult(Perform(serviceName, cancellationToken));
    }

    protected abstract ActionOutcome Perform(string serviceName, CancellationToken cancellationToken);

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

    protected override ActionOutcome Perform(string serviceName, CancellationToken cancellationToken)
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

    protected override ActionOutcome Perform(string serviceName, CancellationToken cancellationToken)
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

    protected override ActionOutcome Perform(string serviceName, CancellationToken cancellationToken)
    {
        Services.Stop(serviceName, ServiceTimeout);
        return Describe(serviceName, "stopped");
    }
}

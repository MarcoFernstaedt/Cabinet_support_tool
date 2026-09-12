using System.Globalization;
using System.Text.Json;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// Shared behaviour for the three process actions.
/// </summary>
/// <remarks>
/// The target is checked against the agent's own policy here, separately from
/// the server's check, before anything below this point runs. Everything after
/// that assumes the name and id have been proved.
/// </remarks>
public abstract class ProcessExecutorBase : IActionExecutor
{
    private readonly ActionOptions _options;

    /// <summary>Creates the executor.</summary>
    /// <param name="processes">Ends and starts processes.</param>
    /// <param name="policy">The agent's own view of what may be targeted.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    protected ProcessExecutorBase(
        IProcessControlGateway processes,
        ProcessTargetPolicy policy,
        IOptions<AgentOptions> options,
        ILogger logger)
    {
        Processes = processes;
        Policy = policy;
        Logger = logger;
        _options = options.Value.Actions;
    }

    /// <summary>Ends and starts processes.</summary>
    protected IProcessControlGateway Processes { get; }

    /// <summary>The agent's own view of what may be targeted.</summary>
    protected ProcessTargetPolicy Policy { get; }

    /// <summary>Diagnostic log.</summary>
    protected ILogger Logger { get; }

    /// <summary>How long a process is given to exit after being asked to.</summary>
    protected TimeSpan ExitTimeout => TimeSpan.FromSeconds(_options.ProcessExitTimeoutSeconds);

    /// <inheritdoc />
    public abstract ActionName Action { get; }

    /// <inheritdoc />
    public abstract Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken);

    /// <summary>Serialises a result for the console to render.</summary>
    /// <param name="result">What the action did.</param>
    /// <param name="summary">One line a person reads.</param>
    protected static ActionOutcome Collected(ProcessActionResultDto result, string summary) =>
        ActionOutcome.Collected(summary, JsonSerializer.Serialize(result, AgentJson.SerializerOptions));
}

/// <summary>
/// Ends one process, named by id and by the name that id is expected to hold.
/// </summary>
/// <remarks>
/// <para>
/// The name check is the point of this executor. Windows reuses process ids
/// within minutes on a busy machine, so between a rep reading a process list
/// and this code running, the id may name something else entirely — plausibly
/// something no allow-list would have permitted. The agent reads the live
/// process table, compares, and refuses the pair if the machine disagrees.
/// </para>
/// <para>
/// It refuses to end its own process under any circumstance, checked by id as
/// well as by name.
/// </para>
/// </remarks>
public sealed class KillProcessExecutor : ProcessExecutorBase
{
    private static readonly string[] PermittedParameters =
    {
        ActionParameterKeys.ProcessId,
        ActionParameterKeys.ExpectedProcessName,
    };

    /// <summary>Creates the executor.</summary>
    /// <param name="processes">Ends and starts processes.</param>
    /// <param name="policy">The agent's own view of what may be targeted.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    public KillProcessExecutor(
        IProcessControlGateway processes,
        ProcessTargetPolicy policy,
        IOptions<AgentOptions> options,
        ILogger<KillProcessExecutor> logger)
        : base(processes, policy, options, logger)
    {
    }

    /// <inheritdoc />
    public override ActionName Action => ActionName.KillProcess;

    /// <inheritdoc />
    public override Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, PermittedParameters, out string unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        if (!ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.ProcessId, out string rawPid, out string pidFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(pidFailure));
        }

        if (!int.TryParse(rawPid, NumberStyles.Integer, CultureInfo.InvariantCulture, out int pid))
        {
            return Task.FromResult(ActionOutcome.Denied(
                $"'{rawPid}' is not a process id."));
        }

        if (!ActionParameters.TryGetRequiredString(
                request,
                ActionParameterKeys.ExpectedProcessName,
                out string expected,
                out string nameFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(nameFailure));
        }

        // Read now, immediately before acting. Anything read earlier is a
        // belief about a machine that has moved on.
        string? observed = Processes.GetProcessName(pid);

        if (observed is null)
        {
            return Task.FromResult(ActionOutcome.Failed(
                $"No process is running with id {pid}. It has already exited, or the id was stale " +
                "by the time this action reached the cabinet."));
        }

        if (!string.Equals(
                ProcessTargetPolicy.Normalise(observed),
                ProcessTargetPolicy.Normalise(expected),
                StringComparison.OrdinalIgnoreCase))
        {
            // Refused, not retried against the name. The rep chose a row in a
            // list; that row no longer describes anything, and guessing which
            // process they meant is how the wrong one gets ended.
            Logger.LogWarning(
                "Action {RequestId} asked to end process {ProcessId}, expecting '{Expected}', but " +
                "that id now belongs to '{Observed}'. Refused.",
                request.Id,
                pid,
                expected,
                observed);

            return Task.FromResult(ActionOutcome.Denied(
                $"Process {pid} is '{observed}', not '{expected}'. Process ids are reused, so this " +
                "id no longer names what was chosen. Nothing was ended. Refresh the process list " +
                "and try again."));
        }

        if (!Policy.IsProcessIdAllowed(pid, observed, out string policyFailure))
        {
            Logger.LogWarning(
                "Action {RequestId} asked to end process {ProcessId} ('{Observed}'), which this agent " +
                "will not touch: {Reason}",
                request.Id,
                pid,
                observed,
                policyFailure);

            return Task.FromResult(ActionOutcome.Denied(policyFailure));
        }

        try
        {
            bool exited = Processes.Kill(pid, ExitTimeout);

            var result = new ProcessActionResultDto
            {
                ProcessName = observed,
                EndedProcessIds = exited ? new[] { pid } : Array.Empty<int>(),
                Refused = exited
                    ? Array.Empty<ProcessActionRefusal>()
                    : new[]
                    {
                        new ProcessActionRefusal
                        {
                            ProcessId = pid,
                            ObservedName = observed,
                            Reason = "The process did not exit within the agent's timeout.",
                        },
                    },
            };

            if (!exited)
            {
                return Task.FromResult(Collected(
                    result,
                    $"Process {pid} ('{observed}') was asked to end but had not exited after " +
                    $"{ExitTimeout.TotalSeconds:F0} seconds. It may still be closing."));
            }

            Logger.LogInformation("Ended process {ProcessId} ('{Observed}').", pid, observed);

            return Task.FromResult(Collected(result, $"Ended process {pid} ('{observed}')."));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Logger.LogWarning(e, "Process {ProcessId} could not be ended.", pid);
            return Task.FromResult(ActionOutcome.Failed(
                $"Process {pid} ('{observed}') could not be ended. {e.Message}"));
        }
    }
}

/// <summary>
/// Ends every process running under one allow-listed image name.
/// </summary>
/// <remarks>
/// Several at once is the normal case rather than an edge one: the applications
/// support ends here routinely run more than one instance, and ending some of
/// them leaves the rep exactly where they started.
/// </remarks>
public sealed class KillProcessByNameExecutor : ProcessExecutorBase
{
    private static readonly string[] PermittedParameters = { ActionParameterKeys.ProcessName };

    /// <summary>Creates the executor.</summary>
    /// <param name="processes">Ends and starts processes.</param>
    /// <param name="policy">The agent's own view of what may be targeted.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    public KillProcessByNameExecutor(
        IProcessControlGateway processes,
        ProcessTargetPolicy policy,
        IOptions<AgentOptions> options,
        ILogger<KillProcessByNameExecutor> logger)
        : base(processes, policy, options, logger)
    {
    }

    /// <inheritdoc />
    public override ActionName Action => ActionName.KillProcessByName;

    /// <inheritdoc />
    public override Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, PermittedParameters, out string unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        if (!ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.ProcessName, out string name, out string missing))
        {
            return Task.FromResult(ActionOutcome.Denied(missing));
        }

        if (!Policy.IsProcessAllowed(name, out string policyFailure))
        {
            Logger.LogWarning(
                "Action {RequestId} asked to end processes named '{ProcessName}', which this agent " +
                "will not touch: {Reason}",
                request.Id,
                name,
                policyFailure);

            return Task.FromResult(ActionOutcome.Denied(policyFailure));
        }

        return Task.FromResult(EndAll(ProcessTargetPolicy.Normalise(name), cancellationToken));
    }

    /// <summary>Ends every instance and reports each one's fate separately.</summary>
    /// <param name="name">The normalised image name.</param>
    /// <param name="cancellationToken">Cancels the action.</param>
    internal ActionOutcome EndAll(string name, CancellationToken cancellationToken)
    {
        IReadOnlyList<int> ids = Processes.GetProcessIds(name);

        if (ids.Count == 0)
        {
            // Not a failure. The requested end state is the actual state.
            return Collected(
                new ProcessActionResultDto { ProcessName = name },
                $"No processes named '{name}' are running, so none were ended.");
        }

        var ended = new List<int>(ids.Count);
        var refused = new List<ProcessActionRefusal>();

        foreach (int pid in ids)
        {
            cancellationToken.ThrowIfCancellationRequested();

            // Re-checked per id even though the name was already permitted: the
            // agent's own process can share a name with a second copy of the
            // same binary, and the id is the fact that settles it.
            if (!Policy.IsProcessIdAllowed(pid, name, out string reason))
            {
                refused.Add(new ProcessActionRefusal
                {
                    ProcessId = pid,
                    ObservedName = name,
                    Reason = reason,
                });

                continue;
            }

            try
            {
                if (Processes.Kill(pid, ExitTimeout))
                {
                    ended.Add(pid);
                }
                else
                {
                    refused.Add(new ProcessActionRefusal
                    {
                        ProcessId = pid,
                        ObservedName = name,
                        Reason = "The process did not exit within the agent's timeout.",
                    });
                }
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                // One process refusing to die does not cost the others. Each
                // outcome is reported on its own row.
                refused.Add(new ProcessActionRefusal
                {
                    ProcessId = pid,
                    ObservedName = name,
                    Reason = e.Message,
                });
            }
        }

        var result = new ProcessActionResultDto
        {
            ProcessName = name,
            EndedProcessIds = ended,
            Refused = refused,
        };

        string summary = refused.Count == 0
            ? $"Ended {ended.Count} process(es) named '{name}'."
            : $"Ended {ended.Count} of {ids.Count} process(es) named '{name}'; " +
              $"{refused.Count} were not ended.";

        Logger.LogInformation(
            "Ended {EndedCount} of {TotalCount} process(es) named '{ProcessName}'.",
            ended.Count,
            ids.Count,
            name);

        return ended.Count == 0 && refused.Count > 0
            ? ActionOutcome.Failed(summary + " " + string.Join(" ", refused.Select(r => r.Reason)))
            : Collected(result, summary);
    }
}

/// <summary>
/// Stops an allow-listed application and starts it again from its registered
/// install path.
/// </summary>
/// <remarks>
/// The path is this machine's own configuration. It is not in the request, not
/// sent by the server, and not searched for: an application with no registered
/// path is refused, because guessing at an executable is how a restart action
/// turns into arbitrary execution.
/// </remarks>
public sealed class RestartApplicationExecutor : ProcessExecutorBase
{
    private static readonly string[] PermittedParameters = { ActionParameterKeys.ApplicationName };

    /// <summary>Creates the executor.</summary>
    /// <param name="processes">Ends and starts processes.</param>
    /// <param name="policy">The agent's own view of what may be targeted.</param>
    /// <param name="options">Agent configuration.</param>
    /// <param name="logger">Diagnostic log.</param>
    public RestartApplicationExecutor(
        IProcessControlGateway processes,
        ProcessTargetPolicy policy,
        IOptions<AgentOptions> options,
        ILogger<RestartApplicationExecutor> logger)
        : base(processes, policy, options, logger)
    {
    }

    /// <inheritdoc />
    public override ActionName Action => ActionName.RestartApplication;

    /// <inheritdoc />
    public override Task<ActionOutcome> ExecuteAsync(
        ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(
                request, PermittedParameters, out string unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        if (!ActionParameters.TryGetRequiredString(
                request, ActionParameterKeys.ApplicationName, out string name, out string missing))
        {
            return Task.FromResult(ActionOutcome.Denied(missing));
        }

        if (!Policy.TryResolveApplication(name, out string executablePath, out string policyFailure))
        {
            Logger.LogWarning(
                "Action {RequestId} asked to restart '{Application}', which this agent will not do: " +
                "{Reason}",
                request.Id,
                name,
                policyFailure);

            return Task.FromResult(ActionOutcome.Denied(policyFailure));
        }

        string application = ProcessTargetPolicy.Normalise(name);

        IReadOnlyList<int> running = Processes.GetProcessIds(application);
        var ended = new List<int>(running.Count);
        var refused = new List<ProcessActionRefusal>();

        foreach (int pid in running)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!Policy.IsProcessIdAllowed(pid, application, out string reason))
            {
                refused.Add(new ProcessActionRefusal
                {
                    ProcessId = pid,
                    ObservedName = application,
                    Reason = reason,
                });

                continue;
            }

            try
            {
                if (Processes.Kill(pid, ExitTimeout))
                {
                    ended.Add(pid);
                }
                else
                {
                    refused.Add(new ProcessActionRefusal
                    {
                        ProcessId = pid,
                        ObservedName = application,
                        Reason = "The process did not exit within the agent's timeout.",
                    });
                }
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                refused.Add(new ProcessActionRefusal
                {
                    ProcessId = pid,
                    ObservedName = application,
                    Reason = e.Message,
                });
            }
        }

        if (refused.Count > 0)
        {
            // Relaunching while an old instance is still holding the device,
            // the database file or the port is how a cabinet ends up with two
            // half-working copies of its dispensing application. Reported as a
            // failure with the old instance left alone, for a person to look at.
            return Task.FromResult(Collected(
                new ProcessActionResultDto
                {
                    ProcessName = application,
                    EndedProcessIds = ended,
                    Refused = refused,
                },
                $"'{application}' was not restarted: {refused.Count} existing instance(s) did not " +
                "stop, and starting another alongside them would leave the cabinet with two."));
        }

        try
        {
            int relaunched = Processes.Start(executablePath);

            Logger.LogInformation(
                "Restarted '{Application}' from its registered path; {EndedCount} old instance(s) " +
                "were ended and the new one is process {ProcessId}.",
                application,
                ended.Count,
                relaunched);

            return Task.FromResult(Collected(
                new ProcessActionResultDto
                {
                    ProcessName = application,
                    EndedProcessIds = ended,
                    RelaunchedProcessId = relaunched == 0 ? null : relaunched,
                },
                ended.Count == 0
                    ? $"'{application}' was not running and has been started."
                    : $"'{application}' was restarted: {ended.Count} instance(s) ended and one started."));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Logger.LogError(e, "'{Application}' was stopped but could not be started again.", application);

            // Reported plainly, because this is the state that needs a person:
            // the application is now down and the restart did not finish.
            return Task.FromResult(ActionOutcome.Failed(
                $"'{application}' was stopped but could not be started again from its registered " +
                $"path. The application is currently not running on this cabinet. {e.Message}"));
        }
    }
}

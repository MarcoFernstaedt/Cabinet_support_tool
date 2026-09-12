using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Actions;

/// <summary>
/// The agent's own half of the process-management guarantees.
/// </summary>
/// <remarks>
/// The server checks all of this first. These tests are about what happens when
/// that check is wrong — a compromised server, a buggy one, or simply a stale
/// process list — because a cabinet that holds controlled substances cannot
/// rely on somebody else's validation being right.
/// </remarks>
public class ProcessTargetPolicyTests
{
    [Theory]
    [InlineData("lsass")]
    [InlineData("LSASS.EXE")]
    [InlineData("csrss")]
    [InlineData("wininit")]
    [InlineData("winlogon")]
    [InlineData("services")]
    [InlineData("smss")]
    [InlineData("System")]
    public void A_critical_windows_process_is_refused_even_when_the_deployment_lists_it(string name)
    {
        // Configured as permitted, which is the case this test exists for: a
        // deployment mistake must cost a refused action, never a bluescreened
        // cabinet. The deny-list is compiled in and consulted first.
        ProcessTargetPolicy policy = Policy(allowed: new[] { name });

        Assert.False(policy.IsProcessAllowed(name, out string reason));
        Assert.Contains("critical", reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void The_agent_refuses_to_end_its_own_process_by_name()
    {
        // Ending the agent removes the only remaining way to reach the cabinet.
        // Checked by name as well as by id, because a kill-by-name would
        // otherwise find it among its matches.
        ProcessTargetPolicy policy = Policy(
            allowed: new[] { "CabinetPlatform.Agent" }, agentName: "CabinetPlatform.Agent");

        Assert.False(policy.IsProcessAllowed("CabinetPlatform.Agent", out string reason));
        Assert.Contains("own process", reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void The_agent_refuses_to_end_its_own_process_id_whatever_it_is_called()
    {
        // By identity, not by name. A second copy of the same binary shares the
        // name; only the id settles which process this actually is.
        ProcessTargetPolicy policy = Policy(allowed: new[] { "notepad" }, agentPid: 4242);

        Assert.False(policy.IsProcessIdAllowed(4242, "notepad", out string reason));
        Assert.Contains("own process", reason, StringComparison.OrdinalIgnoreCase);

        // The same name at a different id is fine.
        Assert.True(policy.IsProcessIdAllowed(4243, "notepad", out _));
    }

    [Fact]
    public void Process_id_four_is_never_a_target()
    {
        // Process id 4 is the Windows kernel on every version of Windows there
        // is. Nothing else uses it.
        ProcessTargetPolicy policy = Policy(allowed: new[] { "notepad" });

        Assert.False(policy.IsProcessIdAllowed(4, "notepad", out string reason));
        Assert.Contains("System process", reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void An_empty_allow_list_denies_everything()
    {
        // An agent nobody configured that silently permitted every process
        // would be far worse than one that refuses until somebody does.
        ProcessTargetPolicy policy = Policy(allowed: Array.Empty<string>());

        Assert.False(policy.IsProcessAllowed("notepad", out string reason));
        Assert.Contains("allow-list is empty", reason, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(@"C:\Windows\notepad.exe")]
    [InlineData("notepad & calc")]
    [InlineData("note*")]
    [InlineData("note\"pad")]
    public void A_name_that_is_not_an_image_name_is_refused_on_sight(string name)
    {
        ProcessTargetPolicy policy = Policy(allowed: new[] { "notepad" });

        Assert.False(policy.IsProcessAllowed(name, out _));
    }

    [Fact]
    public void An_application_with_no_registered_path_is_refused_rather_than_searched_for()
    {
        // Guessing at an executable is how a restart action becomes arbitrary
        // execution. There is no path parameter in the request either.
        ProcessTargetPolicy policy = Policy(allowed: new[] { "CubexClient" });

        Assert.False(policy.TryResolveApplication("CubexClient", out _, out string reason));
        Assert.Contains("registered install path", reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_relative_registered_path_is_refused()
    {
        // A relative path resolves against whatever the agent's working
        // directory happens to be, which is not a decision anybody made.
        ProcessTargetPolicy policy = Policy(
            allowed: new[] { "CubexClient" },
            applications: new Dictionary<string, string> { ["CubexClient"] = @"bin\cubex.exe" });

        Assert.False(policy.TryResolveApplication("CubexClient", out _, out string reason));
        Assert.Contains("absolute", reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_registered_application_resolves_to_the_machines_own_configured_path()
    {
        ProcessTargetPolicy policy = Policy(
            allowed: new[] { "CubexClient" },
            applications: new Dictionary<string, string>
            {
                ["CubexClient"] = @"C:\Program Files\Cubex\CubexClient.exe",
            });

        Assert.True(policy.TryResolveApplication("CubexClient.exe", out string path, out _));
        Assert.Equal(@"C:\Program Files\Cubex\CubexClient.exe", path);
    }

    internal static ProcessTargetPolicy Policy(
        IReadOnlyList<string> allowed,
        IReadOnlyDictionary<string, string>? applications = null,
        string agentName = "CabinetPlatform.Agent",
        int agentPid = 1234)
    {
        var options = new AgentOptions();
        options.Actions.ProcessAllowList = allowed.ToList();
        options.Actions.ApplicationInstallPaths =
            applications?.ToDictionary(p => p.Key, p => p.Value) ?? new Dictionary<string, string>();

        return new ProcessTargetPolicy(
            TestOptions.Create(options),
            new StubProcessControlGateway { CurrentProcessName = agentName, CurrentProcessId = agentPid });
    }
}

/// <summary>The three process executors.</summary>
public class ProcessExecutorTests
{
    [Fact]
    public async Task A_kill_by_id_is_refused_when_the_id_now_belongs_to_something_else()
    {
        // The whole reason a kill carries an expected name. Windows reuses
        // process ids within minutes, so between a rep reading a list and this
        // code running, the id may name something else entirely — plausibly
        // something no allow-list would have permitted.
        var processes = new StubProcessControlGateway();
        processes.Names[900] = "MashuraDispenseHost";

        ActionOutcome outcome = await KillExecutor(processes)
            .ExecuteAsync(KillRequest(900, "notepad"), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, outcome.Status);
        Assert.Contains("not 'notepad'", outcome.Output!, StringComparison.Ordinal);
        Assert.Empty(processes.Killed);
    }

    [Fact]
    public async Task A_kill_by_id_reports_honestly_when_the_process_has_already_gone()
    {
        var processes = new StubProcessControlGateway();

        ActionOutcome outcome = await KillExecutor(processes)
            .ExecuteAsync(KillRequest(901, "notepad"), CancellationToken.None);

        Assert.Equal(ActionStatus.Failed, outcome.Status);
        Assert.Contains("already exited", outcome.Output!, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(processes.Killed);
    }

    [Fact]
    public async Task A_kill_by_id_ends_the_process_when_the_name_still_matches()
    {
        var processes = new StubProcessControlGateway();
        processes.Names[902] = "notepad";

        ActionOutcome outcome = await KillExecutor(processes)
            .ExecuteAsync(KillRequest(902, "notepad"), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        Assert.Equal(new[] { 902 }, processes.Killed);

        // The structured result carries what was ended, which is the evidence a
        // reviewer needs beside the outcome text.
        Assert.NotNull(outcome.CollectedData);
        Assert.Contains("902", outcome.CollectedData!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_kill_by_id_refuses_a_critical_process_even_at_a_matching_name()
    {
        var processes = new StubProcessControlGateway();
        processes.Names[903] = "lsass";

        // Configured as permitted, which is the deployment mistake this refuses.
        ActionOutcome outcome = await KillExecutor(processes, allowed: new[] { "lsass", "notepad" })
            .ExecuteAsync(KillRequest(903, "lsass"), CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, outcome.Status);
        Assert.Contains("critical", outcome.Output!, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(processes.Killed);
    }

    [Fact]
    public async Task A_kill_by_name_ends_every_instance_and_reports_each_one()
    {
        // Several at once is the normal case: the applications support ends
        // here routinely run more than one instance, and ending some of them
        // leaves the rep where they started.
        var processes = new StubProcessControlGateway();
        processes.Names[910] = "notepad";
        processes.Names[911] = "notepad";
        processes.Names[912] = "notepad";

        ActionOutcome outcome = await new KillProcessByNameExecutor(
                processes,
                ProcessTargetPolicyTests.Policy(new[] { "notepad" }, agentPid: 1),
                TestOptions.Create(new AgentOptions()),
                NullLogger<KillProcessByNameExecutor>.Instance)
            .ExecuteAsync(NameRequest("notepad"), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        Assert.Equal(new[] { 910, 911, 912 }, processes.Killed.Order().ToArray());
    }

    [Fact]
    public async Task A_restart_that_cannot_stop_the_old_instance_does_not_start_a_second_one()
    {
        // Two half-working copies of a dispensing application, one holding the
        // device and one holding the database file, is worse than none.
        var processes = new StubProcessControlGateway { RefuseToDie = true };
        processes.Names[920] = "CubexClient";

        ActionOutcome outcome = await new RestartApplicationExecutor(
                processes,
                ProcessTargetPolicyTests.Policy(
                    new[] { "CubexClient" },
                    new Dictionary<string, string> { ["CubexClient"] = @"C:\Cubex\CubexClient.exe" },
                    agentPid: 1),
                TestOptions.Create(new AgentOptions()),
                NullLogger<RestartApplicationExecutor>.Instance)
            .ExecuteAsync(ApplicationRequest("CubexClient"), CancellationToken.None);

        Assert.Null(processes.Started);
        Assert.Contains("did not stop", outcome.Output!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_restart_launches_the_registered_path_and_nothing_else()
    {
        var processes = new StubProcessControlGateway();
        processes.Names[921] = "CubexClient";

        ActionOutcome outcome = await new RestartApplicationExecutor(
                processes,
                ProcessTargetPolicyTests.Policy(
                    new[] { "CubexClient" },
                    new Dictionary<string, string> { ["CubexClient"] = @"C:\Cubex\CubexClient.exe" },
                    agentPid: 1),
                TestOptions.Create(new AgentOptions()),
                NullLogger<RestartApplicationExecutor>.Instance)
            .ExecuteAsync(ApplicationRequest("CubexClient"), CancellationToken.None);

        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        Assert.Equal(new[] { 921 }, processes.Killed);

        // The machine's own configured path, not anything from the request.
        Assert.Equal(@"C:\Cubex\CubexClient.exe", processes.Started);
    }

    [Fact]
    public async Task A_restart_that_stops_the_application_but_cannot_start_it_says_so_plainly()
    {
        // The state that needs a person: the application is now down and the
        // restart did not finish.
        var processes = new StubProcessControlGateway { FailToStart = true };
        processes.Names[922] = "CubexClient";

        ActionOutcome outcome = await new RestartApplicationExecutor(
                processes,
                ProcessTargetPolicyTests.Policy(
                    new[] { "CubexClient" },
                    new Dictionary<string, string> { ["CubexClient"] = @"C:\Cubex\CubexClient.exe" },
                    agentPid: 1),
                TestOptions.Create(new AgentOptions()),
                NullLogger<RestartApplicationExecutor>.Instance)
            .ExecuteAsync(ApplicationRequest("CubexClient"), CancellationToken.None);

        Assert.Equal(ActionStatus.Failed, outcome.Status);
        Assert.Contains("not running", outcome.Output!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_parameter_the_action_does_not_define_is_refused()
    {
        // An unexpected parameter means the agent and the server disagree about
        // what was asked for. On a controlled-substance cabinet the safe
        // reading of that disagreement is to do nothing.
        var processes = new StubProcessControlGateway();
        processes.Names[930] = "notepad";

        ActionRequestDto request = KillRequest(930, "notepad") with
        {
            Parameters = new Dictionary<string, string>
            {
                [ActionParameterKeys.ProcessId] = "930",
                [ActionParameterKeys.ExpectedProcessName] = "notepad",
                [ActionParameterKeys.ServiceName] = "Spooler",
            },
        };

        ActionOutcome outcome = await KillExecutor(processes)
            .ExecuteAsync(request, CancellationToken.None);

        Assert.Equal(ActionStatus.Denied, outcome.Status);
        Assert.Empty(processes.Killed);
    }

    private static KillProcessExecutor KillExecutor(
        StubProcessControlGateway processes, IReadOnlyList<string>? allowed = null) =>
        new(
            processes,
            ProcessTargetPolicyTests.Policy(allowed ?? new[] { "notepad", "MashuraDispenseHost" }, agentPid: 1),
            TestOptions.Create(new AgentOptions()),
            NullLogger<KillProcessExecutor>.Instance);

    private static ActionRequestDto KillRequest(int pid, string expectedName) => Request(
        ActionName.KillProcess,
        new Dictionary<string, string>
        {
            [ActionParameterKeys.ProcessId] = pid.ToString(),
            [ActionParameterKeys.ExpectedProcessName] = expectedName,
        });

    private static ActionRequestDto NameRequest(string name) => Request(
        ActionName.KillProcessByName,
        new Dictionary<string, string> { [ActionParameterKeys.ProcessName] = name });

    private static ActionRequestDto ApplicationRequest(string name) => Request(
        ActionName.RestartApplication,
        new Dictionary<string, string> { [ActionParameterKeys.ApplicationName] = name });

    private static ActionRequestDto Request(
        ActionName action, IReadOnlyDictionary<string, string> parameters) => new()
    {
        Id = Guid.NewGuid(),
        Action = action,
        CabinetId = Guid.NewGuid(),
        Reason = "The dispensing application is not responding.",
        RequestedByUserId = Guid.NewGuid(),
        RequestedUtc = DateTimeOffset.UtcNow,
        Parameters = parameters,
    };
}

/// <summary>A process table a test controls.</summary>
internal sealed class StubProcessControlGateway : IProcessControlGateway
{
    /// <summary>Process id to image name.</summary>
    public Dictionary<int, string> Names { get; } = new();

    /// <summary>Ids this stub was asked to end, in order.</summary>
    public List<int> Killed { get; } = new();

    /// <summary>The path the stub was asked to launch, if any.</summary>
    public string? Started { get; private set; }

    /// <summary>When set, nothing exits within the timeout.</summary>
    public bool RefuseToDie { get; set; }

    /// <summary>When set, launching throws.</summary>
    public bool FailToStart { get; set; }

    /// <inheritdoc />
    public int CurrentProcessId { get; set; } = 1;

    /// <inheritdoc />
    public string CurrentProcessName { get; set; } = "CabinetPlatform.Agent";

    /// <inheritdoc />
    public string? GetProcessName(int processId) => Names.GetValueOrDefault(processId);

    /// <inheritdoc />
    public IReadOnlyList<int> GetProcessIds(string processName) => Names
        .Where(p => string.Equals(p.Value, processName, StringComparison.OrdinalIgnoreCase))
        .Select(p => p.Key)
        .ToArray();

    /// <inheritdoc />
    public bool Kill(int processId, TimeSpan timeout)
    {
        if (RefuseToDie)
        {
            return false;
        }

        Killed.Add(processId);
        Names.Remove(processId);
        return true;
    }

    /// <inheritdoc />
    public int Start(string executablePath)
    {
        if (FailToStart)
        {
            throw new InvalidOperationException("The executable could not be started.");
        }

        Started = executablePath;
        return 5000;
    }
}

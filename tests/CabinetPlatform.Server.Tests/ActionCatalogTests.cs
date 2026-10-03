using System.Reflection;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Services;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// The catalogue is the whole of what this product can do to a cabinet.
/// These tests pin its shape and prove the parameter allow-list is real.
/// </summary>
public sealed class ActionCatalogTests
{
    [Fact]
    public void Legacy_peer_ping_is_unavailable_even_when_maintenance_actions_are_enabled()
    {
        var options = new CabinetPlatform.Server.Configuration.ActionOptions { ExecutionMode = "Maintenance" };
        Assert.False(ActionCatalog.TryGet(ActionName.PingCabinet, options, out _));
        Assert.DoesNotContain(ActionCatalog.Available(options), e => e.Action == ActionName.PingCabinet);
    }

    [Fact]
    public void Every_enum_value_has_exactly_one_catalogue_entry()
    {
        ActionName[] declared = Enum.GetValues<ActionName>();

        Assert.Equal(declared.Length, ActionCatalog.All.Count);

        foreach (ActionName action in declared)
        {
            Assert.True(ActionCatalog.TryGet(action, out _), $"{action} has no catalogue entry.");
        }
    }

    [Fact]
    public void An_integer_outside_the_enum_resolves_to_nothing()
    {
        // A client can put any integer in a JSON body. It must not fall
        // through to a default entry.
        Assert.False(ActionCatalog.TryGet((ActionName)9999, out _));
        Assert.False(ActionCatalog.TryGet((ActionName)0, out _));
    }

    /// <summary>
    /// The approval and disruption matrix, action by action.
    /// </summary>
    /// <remarks>
    /// Role is deliberately absent from this matrix. Every action is Tier 1 in
    /// this build — reps work any cabinet at any time — and repeating that
    /// thirty times here would assert a decision that is stated once in the
    /// catalog and pinned once below. What is worth pinning per action is which
    /// ones need a second person and which ones interrupt a clinic, because
    /// those differ and because getting one wrong is how a cabinet goes down
    /// mid-dispense.
    /// </remarks>
    [Theory]
    // Reads and probes: nobody else need be involved.
    [InlineData(ActionName.ScanForUpdates, false, false)]
    [InlineData(ActionName.GetScheduledUpdates, false, false)]
    [InlineData(ActionName.CancelScheduledUpdates, false, false)]
    [InlineData(ActionName.CollectDiagnosticBundle, false, false)]
    [InlineData(ActionName.CollectEventLogs, false, false)]
    [InlineData(ActionName.RunEventLogView, false, false)]
    [InlineData(ActionName.GetProcessList, false, false)]
    [InlineData(ActionName.FlushDnsCache, false, false)]
    [InlineData(ActionName.RenewDhcpLease, false, false)]
    [InlineData(ActionName.PingHost, false, false)]
    [InlineData(ActionName.TraceRoute, false, false)]
    [InlineData(ActionName.TestPortConnectivity, false, false)]
    [InlineData(ActionName.PingCabinet, false, false)]
    [InlineData(ActionName.TestCabinetPort, false, false)]
    [InlineData(ActionName.TraceRouteToCabinet, false, false)]

    // Restarting an allow-listed service is the one change that needs no
    // second person: it is the routine remedy, it restores the intended state
    // rather than leaving a new one, and requiring approval would mean reps
    // going back to remote desktop for it.
    [InlineData(ActionName.RestartService, false, false)]

    // Changes that leave the cabinet in a state somebody has to remember.
    [InlineData(ActionName.StartService, true, false)]
    [InlineData(ActionName.SetServiceStartType, true, false)]
    [InlineData(ActionName.ScheduleUpdates, true, false)]
    [InlineData(ActionName.KillProcess, true, false)]
    [InlineData(ActionName.KillProcessByName, true, false)]
    [InlineData(ActionName.RestartApplication, true, false)]

    // Disruptive: the cabinet stops doing its job while these run.
    [InlineData(ActionName.StopService, true, true)]
    [InlineData(ActionName.RebootMachine, true, true)]
    [InlineData(ActionName.InstallUpdatesNow, true, true)]
    [InlineData(ActionName.SetDnsServers, true, true)]
    [InlineData(ActionName.SetStaticIpAddress, true, true)]
    [InlineData(ActionName.SetAdapterToDhcp, true, true)]
    public void Catalogue_entries_match_the_specified_matrix(
        ActionName action, bool requiresApproval, bool isDisruptive)
    {
        ActionCatalogEntry entry = ActionCatalog.Get(action);

        Assert.Equal(requiresApproval, entry.RequiresApproval);
        Assert.Equal(isDisruptive, entry.IsDisruptive);
        Assert.True(entry.TimeoutSeconds > 0);
    }

    /// <summary>
    /// Every action a rep can request is Tier 1, and the role comparison is
    /// still the thing that says so.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Reps reach any cabinet at any time. That is how the team already works
    /// over remote desktop, and a tool that pretended otherwise would push the
    /// work back onto remote desktop, where none of this audit trail exists.
    /// </para>
    /// <para>
    /// The three roles stay on users, in tokens and in the trail, and the
    /// <c>MinimumRole</c> comparison runs on every request — so tightening an
    /// action later is a one-line change to its catalog entry rather than the
    /// introduction of a mechanism. This test pins the current values; it is
    /// meant to be edited when somebody decides to tighten one, and to fail
    /// when somebody does it by accident.
    /// </para>
    /// <para>
    /// The reserved actuation entries are excluded because they are not
    /// requestable at any role: the service refuses them on their reserved flag
    /// before it looks at anything else.
    /// </para>
    /// </remarks>
    [Fact]
    public void Every_requestable_action_is_open_to_every_rep()
    {
        foreach (ActionCatalogEntry entry in ActionCatalog.All
                     .Where(e => !e.IsReservedHardwareActuation))
        {
            Assert.Equal(Role.Tier1, entry.MinimumRole);
        }
    }

    /// <summary>
    /// Approval no longer scales with batch size, matching the single-cabinet
    /// rule.
    /// </summary>
    /// <remarks>
    /// The thresholds stay on the entry so the mechanism is still there and
    /// still tested; their values are open, exactly as MinimumRole is. Any rep
    /// may approve another rep's request, of any size — what none of them may
    /// do is approve their own, which is a per-request rule rather than a size
    /// one.
    /// </remarks>
    [Fact]
    public void No_batch_size_currently_demands_a_supervisor()
    {
        foreach (ActionCatalogEntry entry in ActionCatalog.All.Where(e => e.Batchable))
        {
            Assert.Equal(int.MaxValue, entry.BatchSupervisorThreshold);
            Assert.Equal(int.MaxValue, entry.BatchSupervisorOnlyThreshold);
            Assert.True(entry.MaximumBatchSize > 0);
        }
    }

    [Fact]
    public void Reboot_is_the_disruptive_maintenance_window_action_that_yields_to_a_logged_on_user()
    {
        ActionCatalogEntry reboot = ActionCatalog.Get(ActionName.RebootMachine);

        Assert.True(reboot.IsDisruptive);
        Assert.True(reboot.MaintenanceWindowOnly);
        Assert.True(reboot.BlockedIfUserLoggedOn);
        Assert.True(reboot.RequiresApproval);
    }

    [Fact]
    public void No_catalogue_entry_accepts_a_command_script_or_query_parameter()
    {
        string[] forbidden =
        {
            "command", "cmd", "script", "scriptblock", "powershell", "sql", "query",
            "statement", "exec", "execute", "path", "filepath", "arguments", "args", "shell"
        };

        foreach (ActionCatalogEntry entry in ActionCatalog.All)
        {
            foreach (string key in entry.AllowedParameterKeys)
            {
                // The selected identity's path is comparison-only. No launch or
                // other action accepts this exception to the spelling invariant.
                if (entry.Action == ActionName.KillProcess && key == ActionParameterKeys.ExpectedExecutablePath)
                    continue;
                Assert.DoesNotContain(forbidden, f =>
                    key.Contains(f, StringComparison.OrdinalIgnoreCase));
            }
        }
    }

    /// <summary>
    /// The contract types this platform can reach on the way to acting on a
    /// cabinet: what a rep asks for, what the agent is handed, and what comes
    /// back.
    /// </summary>
    /// <remarks>
    /// Closed over their property types, so a command field smuggled in three
    /// levels down a nested record is found just as readily as one on the
    /// request itself.
    /// </remarks>
    private static readonly Type[] ActionPathRoots =
    {
        typeof(CreateActionRequest),
        typeof(CreateBatchActionRequest),
        typeof(ActionRequestDto),
        typeof(ActionRequestView),
        typeof(ActionResultDto),
        typeof(ActionCatalogEntryDto),
        typeof(TestSyncLinkRequest),
    };

    [Fact]
    public void Nothing_on_the_action_path_carries_a_command_script_or_query_field()
    {
        // The rule that matters most, stated over the graph it actually has to
        // hold for: if any type a request, dispatch or result can reach ever
        // grows a command or script property, this fails before it can be
        // wired up to anything.
        string[] forbidden =
        {
            "command", "commandline", "script", "scriptblock", "sql", "query",
            "statement", "powershell", "shell", "shellcommand", "executable",
            "arguments", "args"
        };

        var offenders = new List<string>();

        foreach (Type type in Close(ActionPathRoots))
        {
            foreach (PropertyInfo property in type.GetProperties(
                         BindingFlags.Public | BindingFlags.Instance))
            {
                if (forbidden.Contains(property.Name, StringComparer.OrdinalIgnoreCase))
                {
                    offenders.Add($"{type.Name}.{property.Name}");
                }
            }
        }

        Assert.True(offenders.Count == 0,
            "Command-shaped fields reachable from the action path: " + string.Join(", ", offenders));
    }

    /// <summary>
    /// The only contract property in the product whose name reads as a command,
    /// and why it is allowed to.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>StartupProgramInfo.Command</c> is inbound observation: the string
    /// Windows already holds for a startup entry, reported so a support rep can
    /// read what a machine launches at logon. Ruling 8 requires startup programs
    /// be stored, and a startup entry without its command line tells nobody
    /// anything.
    /// </para>
    /// <para>
    /// It is safe because of the direction it travels, and this test pins that
    /// direction: nothing on the action path can reach it, so there is no route
    /// from a value read off a cabinet back to a value executed on one. If a
    /// second such property ever appears, this fails and somebody has to make
    /// the same argument about it in review.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_only_command_shaped_contract_field_is_inbound_observation()
    {
        string[] forbidden = { "command", "commandline", "script", "sql", "powershell", "shellcommand" };

        HashSet<string> found = typeof(ActionName).Assembly
            .GetTypes()
            .Where(t => t is { IsClass: true, IsAbstract: false })
            .SelectMany(t => t
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => forbidden.Contains(p.Name, StringComparer.OrdinalIgnoreCase))
                .Select(p => $"{t.Name}.{p.Name}"))
            .ToHashSet();

        Assert.Equal(new[] { $"{nameof(StartupProgramInfo)}.Command" }, found.OrderBy(x => x));

        // And it is unreachable from anything that acts.
        Assert.DoesNotContain(typeof(StartupProgramInfo), Close(ActionPathRoots));
    }

    /// <summary>
    /// Every contract type reachable from the given roots through public
    /// properties, collections included.
    /// </summary>
    private static HashSet<Type> Close(IEnumerable<Type> roots)
    {
        var seen = new HashSet<Type>();
        var pending = new Stack<Type>(roots);

        while (pending.Count > 0)
        {
            Type type = Unwrap(pending.Pop());

            if (type.Assembly != typeof(ActionName).Assembly || !seen.Add(type))
            {
                continue;
            }

            foreach (PropertyInfo property in type.GetProperties(
                         BindingFlags.Public | BindingFlags.Instance))
            {
                pending.Push(property.PropertyType);
            }
        }

        return seen;
    }

    /// <summary>Reduces a nullable, array or generic collection type to its element type.</summary>
    private static Type Unwrap(Type type)
    {
        while (true)
        {
            if (Nullable.GetUnderlyingType(type) is { } underlying)
            {
                type = underlying;
                continue;
            }

            if (type.IsArray && type.GetElementType() is { } element)
            {
                type = element;
                continue;
            }

            if (type.IsGenericType && type.GetGenericArguments().Length == 1)
            {
                type = type.GetGenericArguments()[0];
                continue;
            }

            return type;
        }
    }

    /// <summary>
    /// Every operand name in the catalog is one of the shared contract's, and
    /// none of them is a literal.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The merge found four of the nine original actions broken end to end on
    /// exactly this: the server's catalog allowed <c>serviceName</c> while the
    /// agent read <c>ServiceName</c> from a case-sensitive dictionary, and the
    /// server sent <c>delaySeconds</c> for a reboot while the agent permitted
    /// only a supervisor-override key that no longer existed on either side.
    /// </para>
    /// <para>
    /// No build, type check or unit test of either half can see that: the
    /// request arrives, the agent declines it, and the only evidence is an
    /// action that never runs. Sourcing both sides from one class is what makes
    /// the failure impossible rather than merely fixed, and this test is what
    /// keeps a literal from creeping back in.
    /// </para>
    /// </remarks>
    [Fact]
    public void Every_catalogue_parameter_name_comes_from_the_shared_contract()
    {
        HashSet<string> shared = typeof(ActionParameterKeys)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f is { IsLiteral: true, FieldType.Name: nameof(String) })
            .Select(f => (string)f.GetRawConstantValue()!)
            .ToHashSet(StringComparer.Ordinal);

        // The class is not empty, so a rename that emptied it would fail here
        // rather than making every check below vacuously true.
        Assert.NotEmpty(shared);

        var strangers = new List<string>();

        foreach (ActionCatalogEntry entry in ActionCatalog.All)
        {
            foreach (string key in entry.AllowedParameterKeys)
            {
                if (!shared.Contains(key))
                {
                    strangers.Add($"{entry.Action}.{key}");
                }
            }
        }

        Assert.True(strangers.Count == 0,
            "Parameter names not drawn from ActionParameterKeys, which the agent reads from too: " +
            string.Join(", ", strangers));
    }

    [Fact]
    public void The_catalogue_matches_its_parameter_names_case_exactly()
    {
        // Case-insensitive comparison inside the allow-list is a safety net,
        // not a licence: what travels on the wire is the spelling stored on the
        // request, and the agent's dictionary is built from JSON. The two must
        // agree exactly, not merely case-insensitively.
        foreach (ActionCatalogEntry entry in ActionCatalog.All)
        {
            foreach (string key in entry.AllowedParameterKeys)
            {
                Assert.Equal(key, key.ToLowerInvariant()[0] + key[1..]);
                Assert.DoesNotContain(' ', key);
            }
        }
    }

    [Fact]
    public void An_unrecognised_parameter_key_is_rejected_rather_than_dropped()
    {
        IActionParameterValidator validator = CreateValidator();
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.RestartService);

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            entry,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ServiceName] = "Spooler",
                ["command"] = "shutdown /r /t 0"
            },
            DateTimeOffset.UtcNow);

        Assert.False(result.Succeeded);
        Assert.Equal(OperationFailure.Invalid, result.Failure);
        Assert.Contains("command", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_service_name_off_the_allow_list_is_refused()
    {
        IActionParameterValidator validator = CreateValidator();
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.RestartService);

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            entry,
            new Dictionary<string, string> { [ActionParameterKeys.ServiceName] = "NotAnAllowedService" },
            DateTimeOffset.UtcNow);

        Assert.False(result.Succeeded);
        Assert.Contains("allow-list", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void An_allow_listed_service_name_is_accepted_case_insensitively()
    {
        IActionParameterValidator validator = CreateValidator();
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.RestartService);

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            entry,
            new Dictionary<string, string> { [ActionParameterKeys.ServiceName] = "spooler" },
            DateTimeOffset.UtcNow);

        Assert.True(result.Succeeded);
        Assert.Equal("spooler", result.Value![ActionParameterKeys.ServiceName]);
    }

    [Fact]
    public void An_update_cannot_be_scheduled_without_the_cabinet_whose_clock_it_uses()
    {
        // An install time is stated in the cabinet's own local time, so there
        // is no answer to "is this in the future" without the cabinet. Guessing
        // a zone would put the install an arbitrary number of hours from where
        // the rep meant it; the timing cases themselves live in
        // CabinetClockTests, where a zone is supplied.
        IActionParameterValidator validator = CreateValidator();

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            ActionCatalog.Get(ActionName.ScheduleUpdates),
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ScheduledForLocal] = "2030-01-01T03:00:00"
            },
            DateTimeOffset.UtcNow);

        Assert.False(result.Succeeded);
        Assert.Equal(OperationFailure.Invalid, result.Failure);
    }

    [Fact]
    public void An_out_of_range_reboot_delay_is_refused()
    {
        IActionParameterValidator validator = CreateValidator();
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.RebootMachine);

        Assert.False(validator.Validate(
            entry,
            new Dictionary<string, string> { [ActionParameterKeys.DelaySeconds] = "99999" },
            DateTimeOffset.UtcNow).Succeeded);

        Assert.False(validator.Validate(
            entry,
            new Dictionary<string, string> { [ActionParameterKeys.DelaySeconds] = "not-a-number" },
            DateTimeOffset.UtcNow).Succeeded);

        Assert.True(validator.Validate(
            entry,
            new Dictionary<string, string> { [ActionParameterKeys.DelaySeconds] = "60" },
            DateTimeOffset.UtcNow).Succeeded);
    }

    private static IActionParameterValidator CreateValidator() =>
        new ActionParameterValidator(
            new ServiceAllowList(Options.Create(new ServiceAllowListOptions())),
            new ProcessAllowList(Options.Create(new ProcessControlOptions())));
}

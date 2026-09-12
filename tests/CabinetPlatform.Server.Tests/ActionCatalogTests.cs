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

    [Theory]
    [InlineData(ActionName.ScanForUpdates, Role.Tier1, false, false)]
    [InlineData(ActionName.CollectDiagnosticBundle, Role.Tier1, false, false)]
    [InlineData(ActionName.FlushDnsCache, Role.Tier2, false, false)]
    [InlineData(ActionName.RenewDhcpLease, Role.Tier2, false, false)]
    [InlineData(ActionName.RestartService, Role.Tier2, false, false)]
    [InlineData(ActionName.StartService, Role.Tier2, true, false)]
    [InlineData(ActionName.StopService, Role.Tier2, true, true)]
    [InlineData(ActionName.ScheduleUpdates, Role.Tier2, true, false)]
    [InlineData(ActionName.RebootMachine, Role.Tier2, true, true)]
    public void Catalogue_entries_match_the_specified_matrix(
        ActionName action, Role minimumRole, bool requiresApproval, bool isDisruptive)
    {
        ActionCatalogEntry entry = ActionCatalog.Get(action);

        Assert.Equal(minimumRole, entry.MinimumRole);
        Assert.Equal(requiresApproval, entry.RequiresApproval);
        Assert.Equal(isDisruptive, entry.IsDisruptive);
        Assert.True(entry.TimeoutSeconds > 0);
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

    [Fact]
    public void An_unrecognised_parameter_key_is_rejected_rather_than_dropped()
    {
        IActionParameterValidator validator = CreateValidator();
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.RestartService);

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            entry,
            new Dictionary<string, string>
            {
                ["serviceName"] = "Spooler",
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
            new Dictionary<string, string> { ["serviceName"] = "NotAnAllowedService" },
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
            new Dictionary<string, string> { ["serviceName"] = "spooler" },
            DateTimeOffset.UtcNow);

        Assert.True(result.Succeeded);
        Assert.Equal("spooler", result.Value!["serviceName"]);
    }

    [Fact]
    public void A_scheduled_update_time_in_the_past_is_refused()
    {
        IActionParameterValidator validator = CreateValidator();
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.ScheduleUpdates);

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            entry,
            new Dictionary<string, string>
            {
                ["scheduledForUtc"] = DateTimeOffset.UtcNow.AddDays(-1).ToString("O")
            },
            DateTimeOffset.UtcNow);

        Assert.False(result.Succeeded);
    }

    [Fact]
    public void An_out_of_range_reboot_delay_is_refused()
    {
        IActionParameterValidator validator = CreateValidator();
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.RebootMachine);

        Assert.False(validator.Validate(
            entry,
            new Dictionary<string, string> { ["delaySeconds"] = "99999" },
            DateTimeOffset.UtcNow).Succeeded);

        Assert.False(validator.Validate(
            entry,
            new Dictionary<string, string> { ["delaySeconds"] = "not-a-number" },
            DateTimeOffset.UtcNow).Succeeded);

        Assert.True(validator.Validate(
            entry,
            new Dictionary<string, string> { ["delaySeconds"] = "60" },
            DateTimeOffset.UtcNow).Succeeded);
    }

    private static IActionParameterValidator CreateValidator() =>
        new ActionParameterValidator(
            new ServiceAllowList(Options.Create(new ServiceAllowListOptions())));
}

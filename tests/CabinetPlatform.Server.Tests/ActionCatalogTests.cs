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

    [Fact]
    public void No_contract_type_carries_a_free_form_command_field()
    {
        // Belt and braces for the rule that matters most: if a DTO ever grows
        // a command or script property, this fails before it can be wired up.
        string[] forbidden = { "command", "script", "sql", "powershell", "shellcommand" };

        IEnumerable<Type> contractTypes = typeof(Contracts.Enums.ActionName).Assembly
            .GetTypes()
            .Where(t => t is { IsClass: true, IsAbstract: false });

        foreach (Type type in contractTypes)
        {
            foreach (PropertyInfo property in type.GetProperties(
                         BindingFlags.Public | BindingFlags.Instance))
            {
                Assert.DoesNotContain(forbidden, f =>
                    string.Equals(property.Name, f, StringComparison.OrdinalIgnoreCase));
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
                ["serviceName"] = "Spooler",
                ["command"] = "shutdown /r /t 0"
            });

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
            entry, new Dictionary<string, string> { ["serviceName"] = "NotAnAllowedService" });

        Assert.False(result.Succeeded);
        Assert.Contains("allow-list", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void An_allow_listed_service_name_is_accepted_case_insensitively()
    {
        IActionParameterValidator validator = CreateValidator();
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.RestartService);

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            entry, new Dictionary<string, string> { ["serviceName"] = "spooler" });

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
                ["scheduledForUtc"] = DateTime.UtcNow.AddDays(-1).ToString("O")
            });

        Assert.False(result.Succeeded);
    }

    [Fact]
    public void An_out_of_range_reboot_delay_is_refused()
    {
        IActionParameterValidator validator = CreateValidator();
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.RebootMachine);

        Assert.False(validator.Validate(
            entry, new Dictionary<string, string> { ["delaySeconds"] = "99999" }).Succeeded);

        Assert.False(validator.Validate(
            entry, new Dictionary<string, string> { ["delaySeconds"] = "not-a-number" }).Succeeded);

        Assert.True(validator.Validate(
            entry, new Dictionary<string, string> { ["delaySeconds"] = "60" }).Succeeded);
    }

    private static IActionParameterValidator CreateValidator() =>
        new ActionParameterValidator(
            new ServiceAllowList(Options.Create(new ServiceAllowListOptions())));
}

using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Services;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// The server's value rules for the operations the rulings added.
/// </summary>
/// <remarks>
/// An allow-listed key holding a free-form value is arbitrary execution with
/// extra steps. Every one of these parameters names a catalogued thing — a
/// process on an allow-list, an update by its Windows identifier, a port on an
/// allow-list, an address parsed as an address — and these tests pin that the
/// values are proved rather than merely accepted.
/// </remarks>
public sealed class ActionParameterPolicyTests
{
    // ---------------------------------------------------------------------
    // Processes
    // ---------------------------------------------------------------------

    [Theory]
    [InlineData("lsass")]
    [InlineData("LSASS.EXE")]
    [InlineData("csrss")]
    [InlineData("winlogon")]
    [InlineData("services")]
    [InlineData("smss")]
    [InlineData("wininit")]
    [InlineData("System")]
    public void A_critical_windows_process_is_refused_by_name(string name)
    {
        // Killing lsass bluescreens the machine. No role and no grant permits
        // it, and the refusal explains what it would do rather than only that
        // it was refused — a rep who does not understand why will ask again a
        // different way.
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.KillProcessByName,
            new Dictionary<string, string> { [ActionParameterKeys.ProcessName] = name });

        Assert.False(result.Succeeded);
        Assert.Contains("critical", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_critical_process_is_refused_even_when_the_deployment_lists_it()
    {
        // The deny-list is consulted before the allow-list, so a configuration
        // mistake costs a refused action rather than a bluescreened cabinet.
        var configured = new ProcessControlOptions { Processes = new List<string> { "lsass" } };

        var validator = new ActionParameterValidator(
            new ServiceAllowList(Options.Create(new ServiceAllowListOptions())),
            new ProcessAllowList(Options.Create(configured)));

        OperationResult<IReadOnlyDictionary<string, string>> result = validator.Validate(
            ActionCatalog.Get(ActionName.KillProcessByName),
            new Dictionary<string, string> { [ActionParameterKeys.ProcessName] = "lsass" },
            DateTimeOffset.UtcNow);

        Assert.False(result.Succeeded);
    }

    [Fact]
    public void A_kill_by_id_without_the_expected_name_is_refused()
    {
        // Process ids are reused within minutes, so an id on its own is not an
        // identification. The name travels with it and the agent re-reads the
        // live process table before acting.
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.KillProcess,
            new Dictionary<string, string> { [ActionParameterKeys.ProcessId] = "1234" });

        Assert.False(result.Succeeded);
        Assert.Contains("reused", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Process_id_four_is_refused_outright()
    {
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.KillProcess,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ProcessId] = "4",
                [ActionParameterKeys.ExpectedProcessName] = "notepad",
            });

        Assert.False(result.Succeeded);
        Assert.Contains("System process", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_process_outside_the_allow_list_is_refused_rather_than_sanitised()
    {
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.KillProcessByName,
            new Dictionary<string, string> { [ActionParameterKeys.ProcessName] = "sqlservr" });

        Assert.False(result.Succeeded);
        Assert.Contains("allow-list", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_restart_names_an_application_and_has_nowhere_to_put_a_path()
    {
        // The executable comes from the agent's own registration for that name.
        // A path parameter would be a command line wearing a different hat.
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.RestartApplication);

        Assert.Equal(new[] { ActionParameterKeys.ApplicationName }, entry.AllowedParameterKeys.ToArray());

        OperationResult<IReadOnlyDictionary<string, string>> withPath = Validate(
            ActionName.RestartApplication,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ApplicationName] = "CubexClient",
                ["executablePath"] = @"C:\Windows\System32\cmd.exe",
            });

        Assert.False(withPath.Succeeded);
    }

    // ---------------------------------------------------------------------
    // Services
    // ---------------------------------------------------------------------

    [Theory]
    [InlineData("Boot")]
    [InlineData("System")]
    [InlineData("Unknown")]
    public void A_driver_load_order_is_not_a_start_type_support_may_set(string startType)
    {
        // Setting an ordinary service to Boot or System does not make it start
        // earlier; it makes the machine fail to boot.
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.SetServiceStartType,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ServiceName] = "Spooler",
                [ActionParameterKeys.StartType] = startType,
            });

        Assert.False(result.Succeeded);
    }

    [Theory]
    [InlineData("Automatic")]
    [InlineData("AutomaticDelayed")]
    [InlineData("Manual")]
    [InlineData("Disabled")]
    public void The_four_start_types_support_may_set_are_accepted(string startType)
    {
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.SetServiceStartType,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.ServiceName] = "Spooler",
                [ActionParameterKeys.StartType] = startType,
            });

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal(startType, result.Value![ActionParameterKeys.StartType]);
    }

    // ---------------------------------------------------------------------
    // Windows Update
    // ---------------------------------------------------------------------

    [Fact]
    public void An_install_must_name_the_updates_a_person_chose()
    {
        // "Everything applicable" would install whatever had become applicable
        // between the rep choosing and the machine acting, which is not what
        // the clinic agreed to and not what the audit trail would describe.
        OperationResult<IReadOnlyDictionary<string, string>> result =
            Validate(ActionName.InstallUpdatesNow, new Dictionary<string, string>());

        Assert.False(result.Succeeded);
        Assert.Contains("specific updates", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("KB5099999")]
    [InlineData("all")]
    [InlineData("*")]
    public void An_update_id_that_is_not_a_windows_update_identifier_is_refused(string ids)
    {
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.InstallUpdatesNow,
            new Dictionary<string, string> { [ActionParameterKeys.UpdateIds] = ids });

        Assert.False(result.Succeeded);
    }

    [Fact]
    public void A_list_of_update_identifiers_is_normalised()
    {
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.InstallUpdatesNow,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.UpdateIds] =
                    " C1B2A3D4-5E6F-4071-8293-A4B5C6D7E8F9 , d2c3b4a5-6f70-4182-93a4-b5c6d7e8f9a0 ",
            });

        Assert.True(result.Succeeded, result.Reason);

        Assert.Equal(
            "c1b2a3d4-5e6f-4071-8293-a4b5c6d7e8f9,d2c3b4a5-6f70-4182-93a4-b5c6d7e8f9a0",
            result.Value![ActionParameterKeys.UpdateIds]);
    }

    [Fact]
    public void Installing_now_is_disruptive_and_yields_to_a_logged_on_user()
    {
        // An install takes the cabinet out of service and may restart it. A
        // clinician mid-dispense is a chain-of-custody problem, not an
        // inconvenience, and an unreadable logged-on flag blocks it exactly as
        // a true one does.
        ActionCatalogEntry entry = ActionCatalog.Get(ActionName.InstallUpdatesNow);

        Assert.True(entry.IsDisruptive);
        Assert.True(entry.RequiresApproval);
        Assert.True(entry.BlockedIfUserLoggedOn);
    }

    // ---------------------------------------------------------------------
    // Network
    // ---------------------------------------------------------------------

    [Theory]
    [InlineData("dns.example.com")]
    [InlineData("127.0.0.1")]
    [InlineData("169.254.1.1")]
    [InlineData("224.0.0.1")]
    [InlineData("0.0.0.0")]
    public void A_dns_server_that_is_not_a_usable_address_is_refused(string server)
    {
        // Set by address and never by name: a name would have to be resolved by
        // the very resolver being reconfigured. Loopback and link-local answer
        // nothing from anywhere else.
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.SetDnsServers,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.AdapterId] = "{7B2C1D8E-0000-4000-8000-A1B2C3D4E5F6}",
                [ActionParameterKeys.DnsServers] = server,
            });

        Assert.False(result.Succeeded);
    }

    [Fact]
    public void A_subnet_mask_with_a_hole_in_it_is_refused()
    {
        // A mask whose set bits are not contiguous is accepted by nothing and
        // produces a machine that can reach some of its own subnet.
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.SetStaticIpAddress,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.AdapterId] = "{7B2C1D8E-0000-4000-8000-A1B2C3D4E5F6}",
                [ActionParameterKeys.IpAddress] = "10.20.30.41",
                [ActionParameterKeys.SubnetMask] = "255.255.0.255",
            });

        Assert.False(result.Succeeded);
        Assert.Contains("contiguous", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_well_formed_static_configuration_is_accepted()
    {
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.SetStaticIpAddress,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.AdapterId] = "{7B2C1D8E-0000-4000-8000-A1B2C3D4E5F6}",
                [ActionParameterKeys.IpAddress] = "10.20.30.41",
                [ActionParameterKeys.SubnetMask] = "255.255.255.0",
                [ActionParameterKeys.DefaultGateway] = "10.20.30.1",
            });

        Assert.True(result.Succeeded, result.Reason);
    }

    [Theory]
    [InlineData("localhost")]
    [InlineData("127.0.0.1")]
    [InlineData("10.20.30.41; rm -rf /")]
    [InlineData("-notahost")]
    public void A_probe_target_that_is_not_a_usable_host_is_refused(string host)
    {
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.PingHost,
            new Dictionary<string, string> { [ActionParameterKeys.TargetHost] = host });

        Assert.False(result.Succeeded);
    }

    [Theory]
    [InlineData("practice-server.clinic.local")]
    [InlineData("10.20.30.50")]
    public void A_real_host_a_cabinet_might_need_to_reach_is_accepted(string host)
    {
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.PingHost,
            new Dictionary<string, string> { [ActionParameterKeys.TargetHost] = host });

        Assert.True(result.Succeeded, result.Reason);
    }

    [Fact]
    public void A_port_outside_the_cubex_allow_list_is_refused()
    {
        // An unconstrained port parameter is a port scanner with extra steps.
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.TestPortConnectivity,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.TargetHost] = "10.20.30.50",
                [ActionParameterKeys.Port] = "22",
            });

        Assert.False(result.Succeeded);
        Assert.Contains("allow-list", result.Reason!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_cubex_port_is_accepted()
    {
        OperationResult<IReadOnlyDictionary<string, string>> result = Validate(
            ActionName.TestPortConnectivity,
            new Dictionary<string, string>
            {
                [ActionParameterKeys.TargetHost] = "10.20.30.50",
                [ActionParameterKeys.Port] = "1433",
            });

        Assert.True(result.Succeeded, result.Reason);
    }

    private static OperationResult<IReadOnlyDictionary<string, string>> Validate(
        ActionName action, IReadOnlyDictionary<string, string> parameters)
    {
        var validator = new ActionParameterValidator(
            new ServiceAllowList(Options.Create(new ServiceAllowListOptions())),
            new ProcessAllowList(Options.Create(new ProcessControlOptions())));

        return validator.Validate(ActionCatalog.Get(action), parameters, DateTimeOffset.UtcNow);
    }
}

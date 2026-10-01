using System.Xml.Linq;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using CommunityToolkit.Mvvm.Input;

namespace CabinetPlatform.Console.Core.Tests;
public sealed class ConnectivityAlertNavigationTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;
    public ConnectivityAlertNavigationTests(ConsoleTestHost host) => _host = host;
    [Theory]
    [InlineData(Role.Tier1)]
    [InlineData(Role.Tier2)]
    public async Task Both_support_tiers_have_real_queue_navigation_and_source_identity_binding(Role role)
    {
        Assert.NotNull(typeof(ShellViewModel).GetProperty("Alerts"));
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (!File.Exists(Path.Combine(root.FullName, "CabinetPlatform.sln"))) root = root.Parent!;
        var main = XDocument.Load(Path.Combine(root.FullName, "src/CabinetPlatform.Console/Views/MainWindow.xaml"));
        Assert.Contains(main.Descendants(), e => (string?)e.Attribute("Command") == "{Binding ShowAlertsCommand}");
        Assert.Equal("{Binding Alerts}", (string?)Assert.Single(main.Descendants(), e => e.Name.LocalName == "ConnectivityAlertsView").Attribute("DataContext"));
        var view = XDocument.Load(Path.Combine(root.FullName, "src/CabinetPlatform.Console/Views/ConnectivityAlertsView.xaml"));
        Assert.Contains(view.Descendants(), e => (string?)e.Attribute("SelectedItem") == "{Binding SelectedAlert}");
        Assert.Contains(view.Descendants(), e => (string?)e.Attribute("Text") == "{Binding FirewallTriageGuidance}");
        Assert.Contains(view.Descendants(), e => (string?)e.Attribute("Binding") == "{Binding SourceFirewallClueLabel}");
        foreach (var command in new[] { "AcknowledgeCommand", "ResolveCommand", "OpenSourceCommand", "OpenTargetCommand", "NextCommand", "PreviousCommand" })
            Assert.Contains(view.Descendants(), e => (string?)e.Attribute("Command") == "{Binding " + command + "}");
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(role, username);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        var cabinet = await _host.CreateCabinetAsync("SAME-HOST");
        var other = await _host.CreateCabinetAsync("SAME-HOST");
        var announcer = new RecordingLiveRegionAnnouncer(); var time = TimeProvider.System;
        var alerts = new ConnectivityAlertsViewModel(api, session, announcer);
        var invoker = new ActionInvoker(api, ScriptedActionDialog.Accepting(), announcer, session);
        var shell = (ShellViewModel)Activator.CreateInstance(typeof(ShellViewModel),
            new CabinetListViewModel(api, announcer, time), new CabinetFinderViewModel(api, announcer, time),
            new MachineTabViewModel(api, invoker, session, announcer, time), new CabinetTabViewModel(),
            new AuditTabViewModel(api, announcer, time), new FleetTabViewModel(api, announcer, time),
            new ApprovalsViewModel(api, ScriptedApprovalDialog.Accepting(), session, announcer, time),
            new RegistrationsViewModel(api, session, announcer), session, announcer, api, null, alerts)!;
        var show = (IAsyncRelayCommand)typeof(ShellViewModel).GetProperty("ShowAlertsCommand")!.GetValue(shell)!;
        Assert.True(show.CanExecute(null)); await show.ExecuteAsync(null);
        Assert.Equal("Alerts", shell.CurrentView.ToString());
        // Synthetic row only for navigation; ingestion/lifecycle is covered over real HTTP separately.
        var row = new ConnectivityAlertDto { Id = Guid.NewGuid(), SourceCabinetId = cabinet.Id, TargetCabinetId = other.Id };
        alerts.Alerts.Add(row); alerts.SelectedAlert = row;
        ((IRelayCommand)typeof(ConnectivityAlertsViewModel).GetProperty("OpenSourceCommand")!.GetValue(alerts)!).Execute(null);
        await shell.PendingSelectionLoad;
        Assert.Equal(cabinet.Id, shell.Machine.Path!.CabinetId);
        ((IRelayCommand)typeof(ConnectivityAlertsViewModel).GetProperty("OpenTargetCommand")!.GetValue(alerts)!).Execute(null);
        await shell.PendingSelectionLoad;
        Assert.Equal(other.Id, shell.Machine.Path!.CabinetId);
        shell.SignOutCommand.Execute(null);
        Assert.Empty(alerts.Alerts); Assert.Null(alerts.SelectedAlert); Assert.False(show.CanExecute(null));
    }
}

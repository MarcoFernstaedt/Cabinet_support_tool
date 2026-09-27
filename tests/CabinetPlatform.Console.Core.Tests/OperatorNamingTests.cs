using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class OperatorNamingTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;
    public OperatorNamingTests(ConsoleTestHost host) => _host = host;

    [Fact]
    public async Task Cabinet_list_marks_duplicate_friendly_names_and_keeps_both_ids()
    {
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(Role.Supervisor, username);
        var (api, _) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        string client = "labels-" + Guid.NewGuid().ToString("N");
        var first = await _host.CreateCabinetAsync("HOST-A", client);
        var second = await _host.CreateCabinetAsync("HOST-B", client);
        foreach (var cabinet in new[] { first, second })
            await api.RenameCabinetAsync(cabinet.Id, new RenameCabinetRequest { FriendlyName = "Pharmacy", Reason = "Lab label" }, default);
        var vm = new CabinetListViewModel(api, new RecordingLiveRegionAnnouncer(), TimeProvider.System) { ClientFilter = client };
        await vm.LoadAsync();
        Assert.True(vm.HasDuplicateNamesOnPage);
        Assert.Equal(2, vm.Cabinets.Count);
        Assert.All(vm.Cabinets, c => { Assert.True(c.HasDuplicateName); Assert.Equal("Pharmacy", c.Summary.DisplayName); });
        Assert.Equal(new[] { first.Id, second.Id }.Order(), vm.Cabinets.Select(c => c.Id).Order());
    }

    [Fact]
    public async Task Rename_command_uses_loaded_identity_and_refreshes_the_friendly_header()
    {
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(Role.Supervisor, username);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        var cabinet = await _host.CreateCabinetAsync("REPEATED-NAME");
        var announcer = new RecordingLiveRegionAnnouncer();
        var vm = new MachineTabViewModel(api, new ActionInvoker(api, ScriptedActionDialog.Accepting(), announcer, session), session, announcer, TimeProvider.System);
        await vm.LoadAsync(cabinet.Id);
        var name = typeof(MachineTabViewModel).GetProperty("FriendlyName");
        Assert.NotNull(name);
        name.SetValue(vm, "West cabinet");
        typeof(MachineTabViewModel).GetProperty("RenameReason")!.SetValue(vm, "Clarify location");
        var command = (CommunityToolkit.Mvvm.Input.IAsyncRelayCommand)typeof(MachineTabViewModel).GetProperty("RenameCommand")!.GetValue(vm)!;
        Assert.True(command.CanExecute(null));
        await command.ExecuteAsync(null);
        Assert.False(vm.HasError, vm.ErrorMessage);
        Assert.Equal(cabinet.Id, vm.Path!.CabinetId);
        Assert.Equal("West cabinet", vm.HeaderCabinetName);
        Assert.Equal("West cabinet", (await api.GetCabinetLatestAsync(cabinet.Id, default)).Cabinet.FriendlyName);
        vm.Reset();
        Assert.False(command.CanExecute(null));
        Assert.Equal(string.Empty, name.GetValue(vm));
    }

    [Fact]
    public async Task Registration_command_sends_the_chosen_friendly_name()
    {
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(Role.Supervisor, username);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        var pending = new PendingRegistration { MachineId = Guid.NewGuid().ToString(), Hostname = "LAB-PC", Status = RegistrationStatus.Pending, FirstSeenUtc = DateTimeOffset.UtcNow, LastSeenUtc = DateTimeOffset.UtcNow };
        using (var scope = _host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            db.PendingRegistrations.Add(pending);
            await db.SaveChangesAsync();
        }
        var vm = new RegistrationsViewModel(api, session, new RecordingLiveRegionAnnouncer());
        await vm.LoadAsync();
        vm.SelectedRegistration = vm.Queue.Single(r => r.Id == pending.Id);
        vm.ClientName = "Operator client";
        vm.SiteName = "Operator site";
        vm.CabinetRole = CabinetRole.Standalone;
        var property = typeof(RegistrationsViewModel).GetProperty("FriendlyName");
        Assert.NotNull(property);
        property.SetValue(vm, "Dispensing station");
        vm.IdentityConfirmed = true;
        await vm.AcceptCommand.ExecuteAsync(null);
        Assert.False(vm.HasError, vm.ErrorMessage);
        var cabinets = await api.GetCabinetsAsync(new CabinetQuery { ClientName = "Operator client", SiteName = "Operator site" }, default);
        Assert.Equal("Dispensing station", Assert.Single(cabinets.Items).FriendlyName);
        Assert.False(vm.IdentityConfirmed);
    }
}

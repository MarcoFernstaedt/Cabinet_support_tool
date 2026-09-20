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

using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.Extensions.DependencyInjection;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class EnrollmentPagingTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;
    public EnrollmentPagingTests(ConsoleTestHost host) => _host = host;

    [Fact]
    public async Task Supervisor_can_reach_the_next_page_without_carrying_a_previous_identity_confirmation()
    {
        string user = "pages-" + Guid.NewGuid().ToString("N")[..16];
        await _host.CreateUserAsync(Role.Supervisor, user);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = user, Password = ConsoleTestHost.KnownPassword }, CancellationToken.None);
        using (var scope = _host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            for (int i = 0; i < 51; i++) db.PendingRegistrations.Add(new PendingRegistration
            {
                MachineId = "page-machine-" + i, Hostname = "SAME-HOSTNAME", Status = RegistrationStatus.Pending,
                FirstSeenUtc = DateTimeOffset.UtcNow.AddSeconds(i), LastSeenUtc = DateTimeOffset.UtcNow
            });
            await db.SaveChangesAsync();
        }
        var vm = new RegistrationsViewModel(api, session, new RecordingLiveRegionAnnouncer());
        await vm.LoadAsync();
        Assert.Equal(51, vm.TotalCount);
        Assert.Equal(50, vm.Queue.Count);
        Assert.True(vm.NextCommand.CanExecute(null));
        Assert.False(vm.PreviousCommand.CanExecute(null));
        vm.SelectedRegistration = vm.Queue[0];
        vm.IdentityConfirmed = true;
        var firstPageIds = vm.Queue.Select(r => r.Id).ToHashSet();
        await vm.NextCommand.ExecuteAsync(null);
        var remaining = Assert.Single(vm.Queue);
        Assert.DoesNotContain(remaining.Id, firstPageIds);
        Assert.Equal(2, vm.Page);
        Assert.Null(vm.SelectedRegistration);
        Assert.False(vm.IdentityConfirmed);
        Assert.False(vm.NextCommand.CanExecute(null));
        Assert.True(vm.PreviousCommand.CanExecute(null));
        await vm.PreviousCommand.ExecuteAsync(null);
        Assert.Equal(firstPageIds, vm.Queue.Select(r => r.Id).ToHashSet());
        vm.StatusFilter = RegistrationStatus.Rejected;
        Assert.Empty(vm.Queue);
        Assert.False(vm.NextCommand.CanExecute(null));
        Assert.Contains("Rejected", vm.PageSummary);
    }
}

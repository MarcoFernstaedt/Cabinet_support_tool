using System.Net.Http.Headers;
using System.Net.Http.Json;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using Microsoft.Extensions.DependencyInjection;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;
using CommunityToolkit.Mvvm.Input;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class ConnectivityAlertConsoleTests : IClassFixture<ConsoleTestHost>
{
    private readonly ConsoleTestHost _host;
    public ConnectivityAlertConsoleTests(ConsoleTestHost host) => _host = host;

    [Fact]
    public async Task Loaded_cabinet_queue_excludes_other_sources_at_the_same_site()
    {
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(Role.Tier1, username);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        string site = Guid.NewGuid().ToString();
        var first = await _host.CreateCabinetAsync("duplicate", client: "Source client", site: site);
        var second = await _host.CreateCabinetAsync("duplicate", client: "Source client", site: site);
        using (var scope = _host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            db.ConnectivityAlerts.AddRange(new ConnectivityAlert
            { SourceCabinetId = first.Id, TargetCabinetId = second.Id, EvidenceId = Guid.NewGuid(), ReceivedUtc = DateTimeOffset.UtcNow },
                new ConnectivityAlert
                { SourceCabinetId = second.Id, TargetCabinetId = first.Id, EvidenceId = Guid.NewGuid(), ReceivedUtc = DateTimeOffset.UtcNow });
            await db.SaveChangesAsync();
        }
        var vm = new ConnectivityAlertsViewModel(api, session, new RecordingLiveRegionAnnouncer());
        await vm.ShowSiteAsync(first.SiteId, "Source client / " + site);
        Assert.Equal(2, vm.Alerts.Count(a => a.SourceCabinetId == first.Id || a.SourceCabinetId == second.Id));
        await vm.ShowCabinetAsync(first.Id, "duplicate");
        Assert.Null(vm.SiteId);
        Assert.Equal(first.Id, vm.SourceCabinetId);
        Assert.Equal(first.Id, Assert.Single(vm.Alerts).SourceCabinetId);
        vm.SelectedAlert = Assert.Single(vm.Alerts);
        Assert.Null(vm.SelectedAlert.IncidentEvidence);
        Assert.Contains("unavailable", vm.EvidenceAvailability, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("unknown", vm.EvidenceAvailability, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Cabinet:", vm.ScopeSummary);
        await vm.ShowAllAsync();
        Assert.Null(vm.SourceCabinetId);
        Assert.Contains(vm.Alerts, a => a.SourceCabinetId == second.Id);
    }

    [Fact]
    public async Task Site_scope_reaches_authenticated_server_and_global_reset_clears_old_selection()
    {
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(Role.Tier2, username);
        var (api, session) = _host.CreateConsole();
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        string duplicate = Guid.NewGuid().ToString();
        var first = await _host.CreateCabinetAsync("same", client: "A", site: duplicate);
        var second = await _host.CreateCabinetAsync("same", client: "B", site: duplicate);
        using (var scope = _host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
            db.ConnectivityAlerts.AddRange(new ConnectivityAlert
            { SourceCabinetId = first.Id, TargetCabinetId = Guid.NewGuid(), EvidenceId = Guid.NewGuid(), ReceivedUtc = DateTimeOffset.UtcNow },
                new ConnectivityAlert
                { SourceCabinetId = second.Id, TargetCabinetId = Guid.NewGuid(), EvidenceId = Guid.NewGuid(), ReceivedUtc = DateTimeOffset.UtcNow });
            await db.SaveChangesAsync();
        }
        var vm = new ConnectivityAlertsViewModel(api, session, new RecordingLiveRegionAnnouncer());
        await vm.ShowSiteAsync(first.SiteId, "A / " + duplicate);
        Assert.Equal(first.SiteId, vm.SiteId);
        Assert.Contains("A / " + duplicate, vm.ScopeSummary);
        var row = Assert.Single(vm.Alerts);
        Assert.Equal(first.Id, row.SourceCabinetId);
        vm.SelectedAlert = row;
        await vm.ShowAllAsync();
        Assert.Null(vm.SelectedAlert);
        Assert.Null(vm.SiteId);
        Assert.Contains("All sites", vm.ScopeSummary);
        Assert.Contains(vm.Alerts, a => a.SourceCabinetId == first.Id);
        Assert.Contains(vm.Alerts, a => a.SourceCabinetId == second.Id);
        vm.SelectedAlert = vm.Alerts.Single(a => a.SourceCabinetId == first.Id);
        Assert.True(vm.FilterToSelectedSiteCommand.CanExecute(null));
        await vm.FilterToSelectedSiteCommand.ExecuteAsync(null);
        Assert.Equal(first.SiteId, vm.SiteId);
        Assert.True(vm.ShowAllSitesCommand.CanExecute(null));
        await vm.ShowAllSitesCommand.ExecuteAsync(null);
        Assert.Contains(vm.Alerts, a => a.SourceCabinetId == second.Id);
        vm.Reset();
        Assert.Null(vm.SiteId);
        Assert.Empty(vm.Alerts);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Commands_annotate_real_reported_incident_and_open_immutable_source(bool loseAcknowledgementResponse)
    {
        string username = Guid.NewGuid().ToString();
        await _host.CreateUserAsync(Role.Supervisor, username);
        var session = new SessionStore();
        var gate = new LoseCommittedResponse { Lose = loseAcknowledgementResponse, InnerHandler = _host.Server.CreateHandler() };
        using var http = new HttpClient(new BearerTokenHandler(session) { InnerHandler = gate }) { BaseAddress = new Uri("http://localhost") };
        var api = new ApiClient(http, session);
        await api.LoginAsync(new LoginRequest { Username = username, Password = ConsoleTestHost.KnownPassword }, default);
        string site = Guid.NewGuid().ToString();
        var source = await _host.CreateCabinetAsync("SAME-HOST", site: site);
        var target = await _host.CreateCabinetAsync("SAME-HOST", site: site);
        using var supervisor = _host.CreateClient();
        supervisor.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session.AccessToken);
        var json = ContractJson.CreateOptions();
        (await supervisor.PutAsJsonAsync($"/api/connectivity/cabinets/{source.Id}/targets", new ConfigureConnectivityRequest
        { Reason = "Lab", Targets = new[] { new ConnectivityTarget { CabinetId = target.Id, Address = "192.168.10.2" } } }, json)).EnsureSuccessStatusCode();
        using var agent = _host.CreateClient();
        agent.DefaultRequestHeaders.Add("X-Mashura-Agent-Key", "console-test-agent-secret");
        agent.DefaultRequestHeaders.Add("X-Mashura-Machine-Id", source.MachineId);
        var plan = await agent.GetFromJsonAsync<ConnectivityPlan>("/api/agent/connectivity/plan", json);
        var first = DateTimeOffset.UtcNow.AddMinutes(-4);
        (await agent.PostAsJsonAsync("/api/agent/connectivity/summaries", new[] { new ConnectivitySummary
        {
            Id = Guid.NewGuid(), ConfigurationId = plan!.ConfigurationId, SourceCabinetId = source.Id, TargetCabinetId = target.Id,
            FirstObservedUtc = first, LastObservedUtc = first.AddMinutes(2), FailureCount = 3,
            LeadingFailures = 3, TrailingFailures = 3, MaximumFailureRun = 3, LastFailureUtc = first.AddMinutes(2)
        } }, json)).EnsureSuccessStatusCode();
        var type = typeof(ShellViewModel).Assembly.GetType("CabinetPlatform.Console.Core.ViewModels.ConnectivityAlertsViewModel");
        Assert.NotNull(type);
        dynamic vm = Activator.CreateInstance(type, api, session, new RecordingLiveRegionAnnouncer())!;
        await vm.LoadAsync();
        var rows = (IEnumerable<ConnectivityAlertDto>)vm.Alerts;
        var alert = Assert.Single(rows, a => a.SourceCabinetId == source.Id);
        Assert.Equal(3, alert.IncidentEvidence?.FailureCount);
        Assert.Equal(0, alert.IncidentEvidence?.SuccessCount);
        Assert.Equal(first, alert.IncidentEvidence?.FirstObservedUtc);
        vm.SelectedAlert = alert;
        Assert.Contains("historical", (string)vm.EvidenceAvailability, StringComparison.OrdinalIgnoreCase);
        vm.Note = "Investigating";
        await ((IAsyncRelayCommand)vm.AcknowledgeCommand).ExecuteAsync(null);
        Assert.Null((object?)vm.SelectedAlert);
        if (loseAcknowledgementResponse)
        {
            Assert.True((bool)vm.HasError);
            Assert.Contains("not confirmed", (string)vm.Outcome);
            Assert.Empty((IEnumerable<ConnectivityAlertDto>)vm.Alerts);
            Assert.False(((IAsyncRelayCommand)vm.AcknowledgeCommand).CanExecute(null));
            await vm.LoadAsync();
        }
        vm.SelectedAlert = ((IEnumerable<ConnectivityAlertDto>)vm.Alerts).Single(a => a.Id == alert.Id);
        Assert.Equal("Acknowledged", (string)vm.SelectedAlert.Status);
        vm.Note = "Case closed, not a health claim";
        await ((IAsyncRelayCommand)vm.ResolveCommand).ExecuteAsync(null);
        Assert.DoesNotContain((IEnumerable<ConnectivityAlertDto>)vm.Alerts, a => a.Id == alert.Id);
        vm.IncludeResolved = true;
        await vm.LoadAsync();
        vm.SelectedAlert = ((IEnumerable<ConnectivityAlertDto>)vm.Alerts).Single(a => a.Id == alert.Id);
        Assert.Equal("Resolved", (string)vm.SelectedAlert.Status);
        Assert.Equal(source.Id, (Guid)vm.SelectedAlert.SourceCabinetId);
        vm.Reset();
        Assert.Empty((IEnumerable<ConnectivityAlertDto>)vm.Alerts);
        Assert.False(((IAsyncRelayCommand)vm.ResolveCommand).CanExecute(null));
    }
    private sealed class LoseCommittedResponse : DelegatingHandler
    {
        public bool Lose { get; set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var response = await base.SendAsync(request, ct);
            if (Lose && request.RequestUri!.AbsolutePath.EndsWith("/acknowledge", StringComparison.Ordinal))
            {
                response.EnsureSuccessStatusCode(); response.Dispose(); Lose = false;
                throw new HttpRequestException("Synthetic connection loss after committed annotation");
            }
            return response;
        }
    }
}

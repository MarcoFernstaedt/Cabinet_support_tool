using System.Net.Http.Headers;
using System.Net.Http.Json;
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
        vm.SelectedAlert = alert;
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

using System.Net;
using System.Net.Http.Json;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class ConnectivityAlertSafetyTests
{
    [Fact]
    public void Target_navigation_refuses_missing_identity_stale_selection_and_signout()
    {
        var session = new SessionStore();
        session.SignIn("synthetic", DateTimeOffset.UtcNow.AddHours(1), "synthetic", "Lab", Role.Tier2, false);
        using var http = new HttpClient(new Pages()) { BaseAddress = new Uri("http://localhost") };
        var vm = new ConnectivityAlertsViewModel(new ApiClient(http, session), session, new RecordingLiveRegionAnnouncer());
        var chosen = new List<Guid>(); vm.CabinetChosen += (_, id) => chosen.Add(id);
        var missing = new ConnectivityAlertDto { Id = Guid.NewGuid(), SourceCabinetId = Guid.NewGuid() };
        vm.Alerts.Add(missing); vm.SelectedAlert = missing;
        Assert.False(vm.OpenTargetCommand.CanExecute(null)); vm.OpenTargetCommand.Execute(null);
        var stale = new ConnectivityAlertDto { Id = Guid.NewGuid(), SourceCabinetId = Guid.NewGuid(), TargetCabinetId = Guid.NewGuid() };
        vm.SelectedAlert = stale;
        Assert.False(vm.OpenTargetCommand.CanExecute(null)); vm.OpenTargetCommand.Execute(null);
        vm.Alerts.Add(stale); session.SignOut();
        Assert.False(vm.OpenTargetCommand.CanExecute(null)); vm.OpenTargetCommand.Execute(null);
        Assert.Empty(chosen);
    }

    [Fact]
    public void Triage_selection_notifies_binding_on_change_clear_and_reset()
    {
        var session = new SessionStore();
        session.SignIn("synthetic", DateTimeOffset.UtcNow.AddHours(1), "synthetic", "Lab", Role.Tier2, false);
        using var http = new HttpClient(new Pages()) { BaseAddress = new Uri("http://localhost") };
        var vm = new ConnectivityAlertsViewModel(new ApiClient(http, session), session, new RecordingLiveRegionAnnouncer());
        var changes = new List<string?>(); vm.PropertyChanged += (_, e) => changes.Add(e.PropertyName);
        var first = new ConnectivityAlertDto { Id = Guid.NewGuid(), SourceCabinetId = Guid.NewGuid() };
        var second = new ConnectivityAlertDto { Id = Guid.NewGuid(), SourceCabinetId = Guid.NewGuid() };
        vm.Alerts.Add(first); vm.Alerts.Add(second);
        vm.SelectedAlert = first; vm.SelectedAlert = second; vm.SelectedAlert = null;
        Assert.Equal(3, changes.Count(name => name == nameof(vm.FirewallTriageGuidance)));
        vm.SelectedAlert = first; vm.Reset();
        Assert.DoesNotContain(first.SourceCabinetId.ToString(), vm.FirewallTriageGuidance);
        Assert.Equal(5, changes.Count(name => name == nameof(vm.FirewallTriageGuidance)));
    }

    [Fact]
    public void Triage_guidance_keeps_firewall_cause_unknown_and_clears_old_identity()
    {
        var session = new SessionStore();
        session.SignIn("synthetic", DateTimeOffset.UtcNow.AddHours(1), "synthetic", "Lab", Role.Tier2, false);
        using var http = new HttpClient(new Pages()) { BaseAddress = new Uri("http://localhost") };
        var vm = new ConnectivityAlertsViewModel(new ApiClient(http, session), session, new RecordingLiveRegionAnnouncer());
        var source = Guid.NewGuid(); var target = Guid.NewGuid();
        var alert = new ConnectivityAlertDto { Id = Guid.NewGuid(), SourceCabinetId = source, TargetCabinetId = target };
        vm.Alerts.Add(alert); vm.SelectedAlert = alert;
        Assert.Contains(source.ToString(), vm.FirewallTriageGuidance);
        Assert.Contains(target.ToString(), vm.FirewallTriageGuidance);
        Assert.Contains("unknown", vm.FirewallTriageGuidance, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("firewall caused", vm.FirewallTriageGuidance, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("inspect", vm.FirewallTriageGuidance, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("does not change firewall configuration or measured reachability", vm.FirewallTriageGuidance);
        vm.SelectedAlert = null;
        Assert.DoesNotContain(source.ToString(), vm.FirewallTriageGuidance);
        Assert.False(vm.OpenTargetCommand.CanExecute(null));
    }

    [Fact]
    public async Task Queue_pages_are_reachable_and_failed_reload_discards_stale_selection()
    {
        Assert.NotNull(typeof(ConnectivityAlertsViewModel).GetProperty("NextCommand"));
        var session = new SessionStore();
        session.SignIn("synthetic", DateTimeOffset.UtcNow.AddHours(1), "synthetic", "Lab", Role.Tier2, false);
        var handler = new Pages();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("http://localhost") };
        dynamic vm = new ConnectivityAlertsViewModel(new ApiClient(http, session), session, new RecordingLiveRegionAnnouncer());
        await vm.LoadAsync();
        Assert.True(vm.NextCommand.CanExecute(null));
        await vm.NextCommand.ExecuteAsync(null);
        Assert.Contains("page=2", handler.LastQuery);
        Assert.Equal(2, (int)vm.Page);
        vm.SelectedAlert = Assert.Single((IEnumerable<ConnectivityAlertDto>)vm.Alerts);
        vm.Note = "stale"; handler.Fail = true; await vm.LoadAsync();
        Assert.Empty((IEnumerable<ConnectivityAlertDto>)vm.Alerts);
        Assert.Null((object?)vm.SelectedAlert); Assert.True((bool)vm.HasError);
        Assert.False(vm.AcknowledgeCommand.CanExecute(null));
    }
    private sealed class Pages : HttpMessageHandler
    {
        public bool Fail { get; set; }
        public string LastQuery { get; private set; } = "";
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            LastQuery = request.RequestUri!.Query;
            return Task.FromResult(Fail ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) :
                new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(PagedResult<ConnectivityAlertDto>.Create(new[] {
                    new ConnectivityAlertDto { Id = Guid.NewGuid(), SourceCabinetId = Guid.NewGuid() }
                }, LastQuery.Contains("page=2") ? 2 : 1, 50, 51), options: ContractJson.CreateOptions()) });
        }
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Signout_after_annotation_request_discards_late_outcome(bool failure)
    {
        var session = new SessionStore();
        session.SignIn("synthetic", DateTimeOffset.UtcNow.AddHours(1), "synthetic", "Lab", Role.Tier1, false);
        var handler = new Gate { Failure = failure };
        using var http = new HttpClient(handler) { BaseAddress = new Uri("http://localhost") };
        var vm = new ConnectivityAlertsViewModel(new ApiClient(http, session), session, new RecordingLiveRegionAnnouncer());
        await vm.LoadAsync();
        vm.SelectedAlert = Assert.Single(vm.Alerts); vm.Note = "Investigating";
        var pending = vm.AcknowledgeCommand.ExecuteAsync(null);
        await handler.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        session.SignOut(); vm.Reset(); handler.Release.SetResult(); await pending;
        Assert.Empty(vm.Outcome); Assert.Empty(vm.Alerts); Assert.Null(vm.SelectedAlert);
        Assert.False(vm.HasError, vm.ErrorMessage);
        Assert.False(vm.AcknowledgeCommand.CanExecute(null));
    }

    private sealed class Gate : HttpMessageHandler
    {
        public bool Failure { get; init; }
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.Method == HttpMethod.Get)
                return new(HttpStatusCode.OK) { Content = JsonContent.Create(PagedResult<ConnectivityAlertDto>.Create(new[] {
                    new ConnectivityAlertDto { Id = Guid.NewGuid(), SourceCabinetId = Guid.NewGuid() }
                }, 1, 50, 1), options: ContractJson.CreateOptions()) };
            Entered.SetResult(); await Release.Task;
            return new(Failure ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.NoContent);
        }
    }
}

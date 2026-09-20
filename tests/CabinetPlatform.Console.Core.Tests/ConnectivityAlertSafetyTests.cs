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

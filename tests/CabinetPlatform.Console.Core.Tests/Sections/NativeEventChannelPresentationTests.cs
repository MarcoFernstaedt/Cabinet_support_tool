using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Sections;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Tests.Sections;

public sealed class NativeEventChannelPresentationTests
{
    [Fact]
    public void Token_refresh_preserves_channel_draft_but_signout_clears_it()
    {
        var session = new SessionStore();
        session.SignIn("synthetic", DateTimeOffset.UtcNow.AddMinutes(10), "synthetic-refresh", "test", Role.Supervisor, false);
        using var http = new HttpClient();
        var section = new EventLogSectionViewModel();
        section.ConfigureViewCreation(new ApiClient(http, session), session);
        section.NewChannelName = "Vendor/Operational";
        section.NewViewName = "Shared view";
        section.NewViewReason = "Diagnostic reason";
        Assert.True(section.SaveChannelViewCommand.CanExecute(null));
        session.Refreshed("replacement", DateTimeOffset.UtcNow.AddMinutes(20), "replacement-refresh", Role.Supervisor, false);
        Assert.Equal("Vendor/Operational", section.NewChannelName);
        Assert.True(section.SaveChannelViewCommand.CanExecute(null));
        session.SignOut();
        Assert.Empty(section.NewChannelName);
        Assert.False(section.SaveChannelViewCommand.CanExecute(null));
    }

    [Fact]
    public void Rep_cannot_save_even_with_valid_channel_and_reason()
    {
        var session = new SessionStore();
        session.SignIn("synthetic", DateTimeOffset.UtcNow.AddMinutes(10), "synthetic-refresh", "test", Role.Tier2, false);
        using var http = new HttpClient();
        var section = new EventLogSectionViewModel();
        section.ConfigureViewCreation(new ApiClient(http, session), session);
        section.NewChannelName = "Vendor/Operational";
        section.NewViewName = "Shared view";
        section.NewViewReason = "Diagnostic reason";
        Assert.False(section.CanDefineViews);
        Assert.False(section.SaveChannelViewCommand.CanExecute(null));
    }

    [Fact]
    public void All_denied_or_unavailable_reads_and_null_outcomes_are_not_healthy_empty_logs()
    {
        var section = new EventLogSectionViewModel();
        var result = new EventLogViewResultDto
        {
            ViewId = Guid.NewGuid(), ViewDisplayName = "Unreadable", WindowHours = 24, Truncated = false,
            ChannelReads = new[]
            {
                new EventChannelReadResult { Name = "Vendor/Denied", Access = EventChannelAccess.AccessDenied },
                new EventChannelReadResult { Name = "Vendor/Missing", Access = EventChannelAccess.Unavailable }
            }
        };
        section.ApplyResult(result);
        Assert.Contains("incomplete", section.Summarise());
        Assert.Contains("1 access denied", section.ResultSummary);
        Assert.Contains("1 unavailable", section.ResultSummary);
        section.ApplyResult(result with { ChannelReads = new EventChannelReadResult[] { null! } });
        Assert.Contains("outcomes unavailable", section.ResultSummary);
        Assert.Empty(section.ChannelReads);
        section.Apply(null, DateTimeOffset.UtcNow);
        Assert.Empty(section.ChannelReadSummary);
        Assert.Empty(section.ChannelReads);
    }
}

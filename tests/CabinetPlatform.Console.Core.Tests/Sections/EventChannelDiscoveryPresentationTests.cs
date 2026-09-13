using CabinetPlatform.Console.Core.Sections;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Tests.Sections;

public sealed class EventChannelDiscoveryPresentationTests
{
    [Theory]
    [InlineData(EventChannelDiscoveryStatus.AccessDenied, "access denied")]
    [InlineData(EventChannelDiscoveryStatus.Unavailable, "unavailable")]
    public void EmptyViewDoesNotHideDiscoveryFailure(EventChannelDiscoveryStatus status, string expected)
    {
        var section = new EventLogSectionViewModel();
        section.ApplyResult(Result(new EventChannelDiscoveryResult { Status = status }));
        Assert.Contains(expected, section.ResultSummary, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DynamicChannelsExposeAccessAndTruncationWithoutPretendingTheyAreSelectableLogs()
    {
        var section = new EventLogSectionViewModel();
        section.ApplyResult(Result(new EventChannelDiscoveryResult
        {
            Status = EventChannelDiscoveryStatus.Available, Truncated = true,
            Channels = new[]
            {
                new EventChannelInfo { Name = "Vendor-App/Operational", Access = EventChannelAccess.Readable },
                new EventChannelInfo { Name = "Security", Access = EventChannelAccess.AccessDenied },
                new EventChannelInfo { Name = "Vendor/Debug", Access = EventChannelAccess.Disabled },
                new EventChannelInfo { Name = "Vendor/Missing", Access = EventChannelAccess.Unavailable },
            },
        }));
        Assert.Contains("1 readable", section.ResultSummary);
        Assert.Contains("1 access denied", section.ResultSummary);
        Assert.Contains("1 disabled", section.ResultSummary);
        Assert.Contains("1 unavailable", section.ResultSummary);
        Assert.Contains("incomplete", section.ResultSummary);
        Assert.Contains(section.Channels, c => c.Name == "Vendor-App/Operational");
    }

    [Fact]
    public void CabinetRefreshClearsDiscoveryState()
    {
        var section = new EventLogSectionViewModel();
        section.ApplyResult(Result(new EventChannelDiscoveryResult { Status = EventChannelDiscoveryStatus.AccessDenied }));
        section.Apply(null, DateTimeOffset.UtcNow);
        Assert.Empty(section.ChannelDiscoverySummary);
        Assert.Empty(section.Channels);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void MalformedChannelCollectionsDoNotCrashOrLookComplete(bool nullList)
    {
        var section = new EventLogSectionViewModel();
        section.ApplyResult(Result(new EventChannelDiscoveryResult
        {
            Status = EventChannelDiscoveryStatus.Available,
            Channels = nullList ? null! : new EventChannelInfo[] { null! },
        }));
        Assert.Contains("unavailable", section.ResultSummary);
        Assert.Empty(section.Channels);
    }

    private static EventLogViewResultDto Result(EventChannelDiscoveryResult? discovery) => new()
    {
        ViewId = Guid.NewGuid(), ViewDisplayName = "Application", WindowHours = 24, Truncated = false,
        ChannelDiscovery = discovery,
    };
}

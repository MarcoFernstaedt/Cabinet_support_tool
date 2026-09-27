using CabinetPlatform.Console.Core.Sections;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class FirewallPresentationTests
{
    [Fact]
    public void Unread_profile_never_displays_boolean_values_as_known()
    {
        var row = new FirewallProfileRow(new()
        {
            Profile = 1, Status = FirewallReadStatus.AccessDenied,
            Enabled = true, BlockAllInbound = false, DefaultInboundAction = 1, DefaultOutboundAction = 1
        });
        Assert.Equal("Unknown", row.Enabled);
        Assert.Equal("Unknown", row.BlockAllInbound);
        Assert.Equal("Unknown", row.DefaultInbound);
        Assert.Equal("Unknown", row.DefaultOutbound);
    }

    [Fact]
    public void Format_characters_are_rejected_at_the_untrusted_transport_boundary()
    {
        var section = new FirewallSectionViewModel();
        Assert.False(section.TryApply(new()
        {
            ObservedUtc = DateTimeOffset.UtcNow,
            Rules = new[] { new FirewallRuleObservation { Name = "unsafe\u202Ename" } }
        }));
    }
}

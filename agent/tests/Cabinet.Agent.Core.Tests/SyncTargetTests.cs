using System.Net;
using static Cabinet.Agent.Core.Tests.Fixtures;

namespace Cabinet.Agent.Core.Tests;

/// <summary>The guarded console setting for the sync cabinet: the cabinet only accepts targets on its own private network.</summary>
public sealed class SyncTargetTests
{
    private static readonly LocalNetwork[] Lan = [new(IPAddress.Parse("10.20.0.42"), 24)];
    private readonly ManualClock _clock = new(Start);

    private string? Run(JsonObject parameters, LocalNetwork[]? networks = null, int[]? localPorts = null) =>
        new CommandValidator(Config(ports: localPorts), new ReplayStore(null, _clock), new RateLimiter(null, _clock), _clock, () => networks ?? Lan)
            .Validate(Bytes(Command("network.test", parameters))) switch
        {
            ValidationOutcome.Rejected r => r.Rejection.Code,
            ValidationOutcome.Accepted => null,
            _ => "unaddressable",
        };

    private static JsonObject Sync(string address, int? port = null, params int[] ports)
    {
        var p = new JsonObject { ["target"] = "sync_cabinet", ["method"] = port is null ? "ping" : "tcp", ["syncAddress"] = address };
        if (port is not null) p["port"] = port;
        if (ports.Length > 0) p["syncPorts"] = new JsonArray(ports.Select(x => (JsonNode)x).ToArray());
        return p;
    }

    [Fact]
    public void A_sync_cabinet_on_this_cabinets_own_private_network_is_accepted() =>
        Assert.Null(Run(Sync("10.20.0.15")));

    [Theory]
    [InlineData("8.8.8.8")]          // public
    [InlineData("10.20.1.15")]       // private, but another network
    [InlineData("192.168.1.10")]     // private, not connected
    [InlineData("10.20.0.42")]       // this cabinet itself
    [InlineData("10.20.0.0")]        // network address
    [InlineData("10.20.0.255")]      // broadcast
    [InlineData("127.0.0.1")]
    public void Other_sync_addresses_from_the_server_are_refused(string address) =>
        Assert.Equal("invalid_params", Run(Sync(address)));

    [Fact]
    public void A_huge_local_network_does_not_widen_what_the_server_may_reach() =>
        Assert.Equal("invalid_params", Run(Sync("10.99.1.1"), [new(IPAddress.Parse("10.20.0.42"), 8)]));

    [Fact]
    public void Site_sync_ports_allow_tcp_to_the_sync_cabinet_only()
    {
        Assert.Null(Run(Sync("10.20.0.15", 1433, 1433)));
        Assert.Equal("invalid_params", Run(Sync("10.20.0.15", 1434, 1433))); // a port not in the site's list
        var gateway = new JsonObject { ["target"] = "gateway", ["method"] = "tcp", ["port"] = 1433 };
        Assert.Equal("invalid_params", Run(gateway)); // site ports do not apply to other targets
        Assert.Null(Run((JsonObject)gateway.DeepClone(), localPorts: [1433])); // the local allow list still works everywhere
    }

    [Fact]
    public void Local_network_helpers_classify_addresses()
    {
        Assert.True(LocalNetwork.IsPrivate(IPAddress.Parse("172.16.0.1")));
        Assert.True(LocalNetwork.IsPrivate(IPAddress.Parse("172.31.255.1")));
        Assert.False(LocalNetwork.IsPrivate(IPAddress.Parse("172.32.0.1")));
        Assert.False(LocalNetwork.IsPrivate(IPAddress.Parse("::1")));
        Assert.False(LocalNetwork.IsPrivateOnLocalNetwork("not an ip", Lan));
        Assert.False(LocalNetwork.IsPrivateOnLocalNetwork("10.20.0.15", []));
    }
}

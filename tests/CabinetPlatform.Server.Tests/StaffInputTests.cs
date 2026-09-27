using System.Net;
using CabinetPlatform.Contracts.Auth;

namespace CabinetPlatform.Server.Tests;

public sealed class StaffInputTests : IClassFixture<SupportApiFactory>
{
    private readonly SupportApiFactory _factory;
    public StaffInputTests(SupportApiFactory factory) => _factory = factory;

    [Theory]
    [InlineData(" ")]
    [InlineData("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abc")]
    public async Task Invalid_usernames_are_rejected_before_persistence(string username)
    {
        var (supervisor, _) = await TestClient.CreateUserClientAsync(_factory, Role.Supervisor, Guid.NewGuid().ToString());
        var response = await supervisor.PostJsonAsync("/api/users", new CreateUserRequest
        { Username = username, DisplayName = "Support", InitialPassword = "Temporary!Password42", Role = Role.Tier1 });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}

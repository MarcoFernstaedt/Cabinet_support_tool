using System.Security.Claims;
using CabinetPlatform.WebHost.Security;
using Xunit;

namespace CabinetPlatform.WebHost.Tests;

public sealed class EntraSignInTests
{
    [Theory]
    [InlineData("", "app", "secret", "c1")]
    [InlineData("not-a-guid", "app", "secret", "c1")]
    [InlineData("11111111-1111-1111-1111-111111111111", "", "secret", "c1")]
    [InlineData("11111111-1111-1111-1111-111111111111", "app", "", "c1")]
    [InlineData("11111111-1111-1111-1111-111111111111", "app", "secret", "")]
    public void Incomplete_configuration_fails_closed(string tenant, string client, string secret, string context)
    {
        var options = new EntraWebOptions { TenantId = tenant, ClientId = client, ClientSecret = secret, RequiredAuthContext = context };
        Assert.Throws<InvalidOperationException>(() => options.Validate());
    }

    [Fact]
    public void Configured_tenant_and_auth_context_are_required_on_identity()
    {
        var options = ValidOptions();
        var subject = new ClaimsPrincipal(new ClaimsIdentity(new[] {
            new Claim("tid", options.TenantId), new Claim("oid", "33333333-3333-3333-3333-333333333333"), new Claim("acrs", "c1")
        }, "oidc"));
        Assert.True(EntraAssurance.IsSatisfied(subject, options));
        Assert.False(EntraAssurance.IsSatisfied(new ClaimsPrincipal(new ClaimsIdentity(new[] {
            new Claim("tid", options.TenantId), new Claim("oid", "33333333-3333-3333-3333-333333333333"), new Claim("amr", "mfa")
        }, "oidc")), options));
        Assert.False(EntraAssurance.IsSatisfied(new ClaimsPrincipal(new ClaimsIdentity(new[] {
            new Claim("tid", Guid.NewGuid().ToString()), new Claim("oid", "33333333-3333-3333-3333-333333333333"), new Claim("acrs", "c1")
        }, "oidc")), options));
        Assert.False(EntraAssurance.IsSatisfied(new ClaimsPrincipal(new ClaimsIdentity(new[] {
            new Claim("tid", options.TenantId), new Claim("acrs", "c1")
        }, "oidc")), options));
    }

    private static EntraWebOptions ValidOptions() => new()
    {
        TenantId = "11111111-1111-1111-1111-111111111111",
        ClientId = "22222222-2222-2222-2222-222222222222",
        ClientSecret = "synthetic-test-only",
        RequiredAuthContext = "c1"
    };
}

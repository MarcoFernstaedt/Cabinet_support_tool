using CabinetPlatform.Console.Core.Api;

namespace CabinetPlatform.Console.Core.Tests;

public sealed class OfficeConsoleTransportTests
{
    [Theory]
    [InlineData("http://srv1522777.tail72f980.ts.net/")]
    [InlineData("https://user@srv1522777.tail72f980.ts.net/")]
    [InlineData("https://srv1522777.tail72f980.ts.net/api")]
    [InlineData("https://srv1522777.tail72f980.ts.net/?secret=1")]
    [InlineData("https://srv1522777.tail72f980.ts.net/#fragment")]
    [InlineData("not-a-url")]
    public void Console_refuses_non_origin_or_cleartext_endpoints(string address)
    {
        Assert.Throws<InvalidOperationException>(() => new ApiClientOptions { BaseAddress = address }.GetHttpsOrigin());
    }

    [Fact]
    public void Office_origin_uses_normal_certificate_validation_and_never_redirects_credentials()
    {
        var options = new ApiClientOptions { BaseAddress = "https://srv1522777.tail72f980.ts.net/" };
        Assert.Equal(options.BaseAddress, options.GetHttpsOrigin().AbsoluteUri);
        using var handler = ApiClientOptions.CreateTransportHandler();
        Assert.False(handler.AllowAutoRedirect);
        Assert.Null(handler.ServerCertificateCustomValidationCallback);
    }
}

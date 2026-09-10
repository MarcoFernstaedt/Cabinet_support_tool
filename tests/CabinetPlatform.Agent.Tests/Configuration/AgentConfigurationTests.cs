using Microsoft.Extensions.Configuration;

namespace CabinetPlatform.Agent.Tests.Configuration;

/// <summary>
/// Guards the rule that the agent's server endpoint and check-in cadence are
/// configuration, never constants compiled into the agent.
/// </summary>
public class AgentConfigurationTests
{
    private static IConfigurationRoot LoadAgentConfiguration() =>
        new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: false)
            .Build();

    [Fact]
    public void AppSettings_SuppliesServerEndpoint()
    {
        var serverBaseUrl = LoadAgentConfiguration()["Agent:ServerBaseUrl"];

        Assert.False(string.IsNullOrWhiteSpace(serverBaseUrl));
        Assert.True(Uri.TryCreate(serverBaseUrl, UriKind.Absolute, out var uri));

        // The agent reaches out to the server over TLS. Nothing listens for
        // inbound connections into a cabinet.
        Assert.Equal(Uri.UriSchemeHttps, uri!.Scheme);
    }

    [Fact]
    public void AppSettings_SuppliesCheckInInterval()
    {
        var interval = LoadAgentConfiguration().GetValue<int?>("Agent:CheckInIntervalSeconds");

        Assert.NotNull(interval);
        Assert.True(interval > 0, "The check-in interval must be a positive number of seconds.");
    }

    [Fact]
    public void AppSettings_CarriesNoSecrets()
    {
        var configuration = LoadAgentConfiguration();

        // Credentials belong in user-secrets locally and in the deployment's
        // own secret store in production, never in a committed file.
        foreach (var entry in configuration.AsEnumerable())
        {
            Assert.DoesNotContain("password", entry.Key, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("secret", entry.Key, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("apikey", entry.Key.Replace("_", string.Empty), StringComparison.OrdinalIgnoreCase);
        }
    }
}

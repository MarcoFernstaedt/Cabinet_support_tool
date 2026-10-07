using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Core.Packages;

/// <summary>
/// The network process's half of package.install: download the approved package from the platform
/// server into the network service's own downloads folder, then hand the command to the broker,
/// which copies it into its staging folder and checks it. The network process checks nothing that
/// matters here; every check that counts runs in the broker on its own copy.
/// </summary>
public sealed class PackageDownloads(string downloads)
{
    /// <summary>The connection to the server while online; set by <see cref="AgentConnection"/>.</summary>
    public AgentApiClient? Client { get; set; }

    public void Register(OperationRegistry registry, Func<string, System.Text.Json.JsonElement, CancellationToken, Task<System.Text.Json.JsonElement>> broker) =>
        registry.RegisterRaw(Catalog.PackageInstall, async (raw, token) =>
        {
            var p = System.Text.Json.JsonSerializer.Deserialize<PackageInstallParams>(raw, ContractJson.Options)!;
            AgentApiClient client = Client ?? throw new OperationFailedException("unavailable", "The platform server is not connected.");
            Directory.CreateDirectory(downloads);
            try { await client.DownloadPackageAsync(p.PackageId, PackageInstaller.DownloadPath(downloads, p.PackageId), PackageInstaller.MaxPackageBytes, token).ConfigureAwait(false); }
            catch (AgentApiException e) { throw new OperationFailedException("unavailable", e.Message); }
            return await broker(Catalog.PackageInstall, raw, token).ConfigureAwait(false);
        });
}

using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Configuration;

/// <summary>
/// Collects the configuration categories (docs/spec/15-baselines-and-config.md) from the same read operations a technician
/// would run one at a time, so a snapshot can show nothing a read operation could not: no new Windows access, no new privilege, no file
/// content. A category is complete or left out: one that cannot be read now is skipped, never sent partly, so a failed read can never
/// look like a change. The reads run one after another, never in parallel, and each one goes through the operation's own code.
/// </summary>
public sealed class ConfigCollector(Func<string, JsonElement, CancellationToken, Task<JsonElement>> run, string machineName, TimeProvider clock, Action<string> log)
{
    public static readonly IReadOnlyList<ConfigCategory> All = Enum.GetValues<ConfigCategory>();
    private static readonly JsonElement NoParams = JsonSerializer.SerializeToElement(new EmptyParams(), ContractJson.Options);

    public async Task<ConfigSnapshotOutput> CollectAsync(IReadOnlyList<ConfigCategory>? wanted, CancellationToken token)
    {
        var categories = new List<ConfigSnapshotCategory>();
        foreach (ConfigCategory category in All)
        {
            if (wanted is not null && !wanted.Contains(category)) continue;
            token.ThrowIfCancellationRequested();
            try { categories.Add(await BuildAsync(category, token).ConfigureAwait(false)); }
            catch (Exception e) when (e is OperationFailedException or JsonException or IOException or UnauthorizedAccessException or InvalidOperationException or NotSupportedException)
            {
                log($"Configuration: {category.ToString().ToLowerInvariant()} could not be read ({e.GetType().Name}); left out of this snapshot.");
            }
        }
        return new ConfigSnapshotOutput { TakenAt = clock.GetUtcNow(), Categories = Fit(categories) };
    }

    /// <summary>Keeps one snapshot under its size budget (it is sent as one request): the largest category is cut, and says so, until it fits.</summary>
    public static IReadOnlyList<ConfigSnapshotCategory> Fit(IReadOnlyList<ConfigSnapshotCategory> categories)
    {
        var list = categories.ToList();
        long total = list.Sum(ConfigBuilders.Size);
        while (total > ConfigBuilders.MaxSnapshotBytes && list.Count > 0)
        {
            int at = 0;
            for (int i = 1; i < list.Count; i++) if (ConfigBuilders.Size(list[i]) > ConfigBuilders.Size(list[at])) at = i;
            if (list[at].Items.Count == 0) break;
            list[at] = ConfigBuilders.Cut(list[at], list[at].Items.Count * 3 / 4);
            total = list.Sum(ConfigBuilders.Size);
        }
        return list;
    }

    private async Task<T> Read<T>(string operation, CancellationToken token) =>
        (await run(operation, NoParams, token).ConfigureAwait(false)).Deserialize<T>(ContractJson.Options)!;

    private async Task<ConfigSnapshotCategory> BuildAsync(ConfigCategory category, CancellationToken token)
    {
        switch (category)
        {
            case ConfigCategory.Network: return ConfigBuilders.Network(await Read<NetworkConfigOutput>(Catalog.NetworkConfig, token).ConfigureAwait(false));
            case ConfigCategory.Services: return ConfigBuilders.Services(await Read<ServicesListOutput>(Catalog.ServicesList, token).ConfigureAwait(false));
            case ConfigCategory.Drivers: return ConfigBuilders.Drivers(await Read<DriversListOutput>(Catalog.DriversList, token).ConfigureAwait(false));
            case ConfigCategory.Updates: return ConfigBuilders.Updates(await Read<UpdatesStatusOutput>(Catalog.UpdatesStatus, token).ConfigureAwait(false));
            case ConfigCategory.Firewall: return ConfigBuilders.Firewall(await Read<FirewallStateOutput>(Catalog.FirewallState, token).ConfigureAwait(false));
            case ConfigCategory.Time: return ConfigBuilders.Time(await Read<TimeStatusOutput>(Catalog.TimeStatus, token).ConfigureAwait(false));
            case ConfigCategory.Devices:
                JsonElement all = await run(Catalog.DevicesList, JsonSerializer.SerializeToElement(new DevicesListParams(), ContractJson.Options), token).ConfigureAwait(false);
                return ConfigBuilders.Devices(all.Deserialize<DevicesListOutput>(ContractJson.Options)!);
            case ConfigCategory.Applications: return ConfigBuilders.Applications(await Read<SoftwareListOutput>(Catalog.SoftwareList, token).ConfigureAwait(false));
            case ConfigCategory.Hosts: return ConfigBuilders.Hosts(await Read<NetworkHostsOutput>(Catalog.NetworkHosts, token).ConfigureAwait(false));
            case ConfigCategory.Tasks: return ConfigBuilders.Tasks(await Read<StartupListOutput>(Catalog.StartupList, token).ConfigureAwait(false));
            case ConfigCategory.System:
                var hardware = await Read<SystemHardwareOutput>(Catalog.SystemHardware, token).ConfigureAwait(false);
                var identity = await Read<SystemIdentityOutput>(Catalog.SystemIdentity, token).ConfigureAwait(false);
                return ConfigBuilders.Machine(hardware, identity, machineName);
            default: throw new InvalidOperationException("Unknown configuration category.");
        }
    }
}

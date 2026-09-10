using System.Globalization;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Reads the installed-software inventory from the registry.
/// </summary>
/// <remarks>
/// Both uninstall paths are read. On a 64-bit cabinet the WOW6432Node path
/// holds every 32-bit application, which on these machines is most of the
/// clinical software and the drivers support actually cares about; reading only
/// the native path returns a tidy, short and badly wrong inventory.
/// </remarks>
public sealed class InstalledSoftwareReader
{
    private const string NativeUninstallPath =
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

    private const string WowUninstallPath =
        @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

    private readonly IRegistryReader _registry;

    public InstalledSoftwareReader(IRegistryReader registry) => _registry = registry;

    public IReadOnlyList<InstalledSoftwareInfo> Read(int maximumEntries)
    {
        var found = new Dictionary<string, InstalledSoftwareInfo>(StringComparer.OrdinalIgnoreCase);

        // The 64-bit view of the native path and the explicit WOW6432Node path
        // together cover both architectures regardless of the agent's own
        // bitness or how the registry redirector treats it.
        ReadPath(NativeUninstallPath, RegistryViewScope.Registry64, found);
        ReadPath(NativeUninstallPath, RegistryViewScope.Registry32, found);
        ReadPath(WowUninstallPath, RegistryViewScope.Registry64, found);

        return found.Values
            .OrderBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase)
            .Take(maximumEntries)
            .ToArray();
    }

    private void ReadPath(
        string path,
        RegistryViewScope view,
        IDictionary<string, InstalledSoftwareInfo> found)
    {
        foreach (var subKeyName in _registry.GetSubKeyNames(RegistryHiveScope.LocalMachine, path, view))
        {
            var keyPath = $@"{path}\{subKeyName}";

            var name = AsString(_registry.GetValue(RegistryHiveScope.LocalMachine, keyPath, "DisplayName", view));
            if (string.IsNullOrWhiteSpace(name))
            {
                // Entries without a display name are not shown in Programs and
                // Features either; they are components, not applications.
                continue;
            }

            // Hotfix and component entries would swamp the real inventory.
            if (AsInt(_registry.GetValue(RegistryHiveScope.LocalMachine, keyPath, "SystemComponent", view)) == 1)
            {
                continue;
            }

            if (_registry.GetValue(RegistryHiveScope.LocalMachine, keyPath, "ParentKeyName", view) is not null)
            {
                continue;
            }

            var version = AsString(_registry.GetValue(RegistryHiveScope.LocalMachine, keyPath, "DisplayVersion", view));
            var publisher = AsString(_registry.GetValue(RegistryHiveScope.LocalMachine, keyPath, "Publisher", view));
            var installDate = ParseInstallDate(
                AsString(_registry.GetValue(RegistryHiveScope.LocalMachine, keyPath, "InstallDate", view)));

            // The same product appears in both views on some installers.
            var identity = $"{name} {version}";
            found.TryAdd(identity, new InstalledSoftwareInfo
            {
                Name = name,
                Version = version,
                Publisher = publisher,
                InstallDate = installDate,
            });
        }
    }

    /// <summary>
    /// Parses the <c>yyyyMMdd</c> string installers write to InstallDate.
    /// </summary>
    /// <remarks>
    /// It carries no time and no zone, so it is anchored at midnight UTC rather
    /// than being shifted by whatever zone the cabinet happens to sit in.
    /// </remarks>
    internal static DateTimeOffset? ParseInstallDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return DateTime.TryParseExact(
            value.Trim(),
            "yyyyMMdd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out var parsed)
            ? new DateTimeOffset(parsed, TimeSpan.Zero)
            : null;
    }

    private static string? AsString(object? value)
    {
        var text = value?.ToString();
        return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
    }

    private static int? AsInt(object? value)
    {
        if (value is null)
        {
            return null;
        }

        try
        {
            return Convert.ToInt32(value, CultureInfo.InvariantCulture);
        }
        catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException)
        {
            return null;
        }
    }
}

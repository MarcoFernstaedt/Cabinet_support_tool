using System.Runtime.Versioning;
using System.Security;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Reads the local registry. Never writes to it.</summary>
[SupportedOSPlatform("windows")]
public sealed class RegistryReader : IRegistryReader
{
    private readonly ILogger<RegistryReader> _logger;

    public RegistryReader(ILogger<RegistryReader> logger) => _logger = logger;

    public bool KeyExists(RegistryHiveScope hive, string keyPath, RegistryViewScope view)
        => WithKey(hive, keyPath, view, _ => true, false);

    public IReadOnlyList<string> GetSubKeyNames(RegistryHiveScope hive, string keyPath, RegistryViewScope view)
        => WithKey<IReadOnlyList<string>>(hive, keyPath, view, key => key.GetSubKeyNames(), Array.Empty<string>());

    public IReadOnlyList<string> GetValueNames(RegistryHiveScope hive, string keyPath, RegistryViewScope view)
        => WithKey<IReadOnlyList<string>>(hive, keyPath, view, key => key.GetValueNames(), Array.Empty<string>());

    public object? GetValue(RegistryHiveScope hive, string keyPath, string valueName, RegistryViewScope view)
        => WithKey<object?>(hive, keyPath, view, key => key.GetValue(valueName), null);

    private T WithKey<T>(
        RegistryHiveScope hive,
        string keyPath,
        RegistryViewScope view,
        Func<RegistryKey, T> read,
        T fallback)
    {
        try
        {
            using var baseKey = RegistryKey.OpenBaseKey(ToHive(hive), ToView(view));
            using var key = baseKey.OpenSubKey(keyPath, writable: false);
            return key is null ? fallback : read(key);
        }
        catch (Exception e) when (e is SecurityException or UnauthorizedAccessException or IOException)
        {
            // An unreadable key is reported as absent rather than crashing the
            // collector that asked for it.
            _logger.LogDebug(e, "Registry key {KeyPath} could not be read.", keyPath);
            return fallback;
        }
    }

    private static RegistryHive ToHive(RegistryHiveScope hive) => hive switch
    {
        RegistryHiveScope.LocalMachine => RegistryHive.LocalMachine,
        RegistryHiveScope.CurrentUser => RegistryHive.CurrentUser,
        RegistryHiveScope.Users => RegistryHive.Users,
        _ => RegistryHive.LocalMachine,
    };

    private static RegistryView ToView(RegistryViewScope view) => view switch
    {
        RegistryViewScope.Registry32 => RegistryView.Registry32,
        RegistryViewScope.Registry64 => RegistryView.Registry64,
        _ => RegistryView.Default,
    };
}

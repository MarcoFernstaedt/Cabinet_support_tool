using CabinetPlatform.Agent.Platform;

namespace CabinetPlatform.Agent.Tests.Platform;

/// <summary>
/// An in-memory registry.
/// </summary>
/// <remarks>
/// Keys are tracked per view, which is the whole point: a test can put a 32-bit
/// application only in the WOW6432Node path and prove the reader still finds it.
/// </remarks>
internal sealed class FakeRegistryReader : IRegistryReader
{
    private readonly Dictionary<string, Dictionary<string, object?>> _keys = new(StringComparer.OrdinalIgnoreCase);

    public FakeRegistryReader AddKey(
        string keyPath,
        RegistryViewScope view = RegistryViewScope.Registry64,
        params (string Name, object? Value)[] values)
    {
        var composite = Compose(keyPath, view);
        if (!_keys.TryGetValue(composite, out var existing))
        {
            existing = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            _keys[composite] = existing;
        }

        foreach (var (name, value) in values)
        {
            existing[name] = value;
        }

        return this;
    }

    public bool KeyExists(RegistryHiveScope hive, string keyPath, RegistryViewScope view)
        => _keys.ContainsKey(Compose(keyPath, view));

    public IReadOnlyList<string> GetSubKeyNames(RegistryHiveScope hive, string keyPath, RegistryViewScope view)
    {
        var prefix = Compose(keyPath, view) + "\\";

        return _keys.Keys
            .Where(key => key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .Select(key => key[prefix.Length..].Split('\\')[0])
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public IReadOnlyList<string> GetValueNames(RegistryHiveScope hive, string keyPath, RegistryViewScope view)
        => _keys.TryGetValue(Compose(keyPath, view), out var values)
            ? values.Keys.ToArray()
            : Array.Empty<string>();

    public object? GetValue(RegistryHiveScope hive, string keyPath, string valueName, RegistryViewScope view)
        => _keys.TryGetValue(Compose(keyPath, view), out var values) && values.TryGetValue(valueName, out var value)
            ? value
            : null;

    private static string Compose(string keyPath, RegistryViewScope view) => $"{view}::{keyPath}";
}

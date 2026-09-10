namespace CabinetPlatform.Agent.Platform;

/// <summary>Registry hives the agent reads. Read-only by design.</summary>
public enum RegistryHiveScope
{
    LocalMachine = 0,
    CurrentUser = 1,
    Users = 2,
}

/// <summary>
/// Which of the two registry views to read.
/// </summary>
/// <remarks>
/// A 64-bit process reading only the native view misses every 32-bit
/// application's uninstall entry, which on a cabinet is most of the clinical
/// software. Both views are always read where installed software is concerned.
/// </remarks>
public enum RegistryViewScope
{
    Default = 0,
    Registry64 = 1,
    Registry32 = 2,
}

/// <summary>
/// Registry access as an injected dependency, so collectors that interpret
/// registry data can be tested with fixtures.
/// </summary>
public interface IRegistryReader
{
    bool KeyExists(RegistryHiveScope hive, string keyPath, RegistryViewScope view);

    IReadOnlyList<string> GetSubKeyNames(RegistryHiveScope hive, string keyPath, RegistryViewScope view);

    IReadOnlyList<string> GetValueNames(RegistryHiveScope hive, string keyPath, RegistryViewScope view);

    object? GetValue(RegistryHiveScope hive, string keyPath, string valueName, RegistryViewScope view);
}

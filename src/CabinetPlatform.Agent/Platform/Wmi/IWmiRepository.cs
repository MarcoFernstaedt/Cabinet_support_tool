namespace CabinetPlatform.Agent.Platform.Wmi;

/// <summary>Well-known WMI namespaces the agent reads from.</summary>
public static class WmiScopes
{
    public const string CimV2 = @"root\CIMV2";
    public const string Storage = @"root\Microsoft\Windows\Storage";
    public const string VolumeEncryption = @"root\CIMV2\Security\MicrosoftVolumeEncryption";
    public const string Wmi = @"root\WMI";
    public const string StandardCimV2 = @"root\StandardCimv2";
}

/// <summary>
/// The agent's whole view of WMI. Collectors take this through their
/// constructor, which is what lets them be exercised without a WMI provider.
/// </summary>
public interface IWmiRepository
{
    /// <summary>Runs a WQL query and materialises every row.</summary>
    IReadOnlyList<WmiRecord> Query(string scope, string query);

    /// <summary>
    /// Invokes a method on each instance matched by a query, returning the
    /// provider's return code per instance.
    /// </summary>
    IReadOnlyList<WmiMethodResult> InvokeMethod(
        string scope,
        string query,
        string methodName,
        IReadOnlyDictionary<string, object?>? parameters = null);
}

/// <summary>Outcome of one instance's method invocation.</summary>
public sealed record WmiMethodResult
{
    public required string InstancePath { get; init; }

    /// <summary>The provider's numeric return value; 0 means success.</summary>
    public required uint ReturnValue { get; init; }

    /// <summary>
    /// The method's output parameters. BitLocker's conversion and lock state,
    /// for example, are only available this way and not as properties.
    /// </summary>
    public WmiRecord? Output { get; init; }

    public bool Succeeded => ReturnValue == 0;
}

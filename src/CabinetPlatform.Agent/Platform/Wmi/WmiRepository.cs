using System.Management;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Platform.Wmi;

/// <summary>
/// The real WMI implementation. It is deliberately thin: it converts
/// <c>ManagementBaseObject</c> rows into <see cref="WmiRecord"/> and does
/// nothing else, so that all interpretation lives in collectors that can be
/// tested without it.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WmiRepository : IWmiRepository
{
    private readonly ILogger<WmiRepository> _logger;

    public WmiRepository(ILogger<WmiRepository> logger) => _logger = logger;

    public IReadOnlyList<WmiRecord> Query(string scope, string query)
    {
        using var searcher = new ManagementObjectSearcher(
            new ManagementScope(scope),
            new ObjectQuery(query),
            new System.Management.EnumerationOptions { ReturnImmediately = true, Rewindable = false });

        var records = new List<WmiRecord>();
        using var results = searcher.Get();

        foreach (var row in results)
        {
            using var managementObject = (ManagementBaseObject)row;
            records.Add(ToRecord(managementObject));
        }

        return records;
    }

    public IReadOnlyList<WmiMethodResult> InvokeMethod(
        string scope,
        string query,
        string methodName,
        IReadOnlyDictionary<string, object?>? parameters = null)
    {
        using var searcher = new ManagementObjectSearcher(
            new ManagementScope(scope),
            new ObjectQuery(query));

        var results = new List<WmiMethodResult>();
        using var matches = searcher.Get();

        foreach (var match in matches)
        {
            using var instance = (ManagementObject)match;
            var path = instance.Path?.RelativePath ?? string.Empty;

            ManagementBaseObject? arguments = null;
            try
            {
                if (parameters is { Count: > 0 })
                {
                    // GetMethodParameters returns null for a method that takes
                    // no arguments, which is not an error worth failing on.
                    arguments = instance.GetMethodParameters(methodName);
                    if (arguments is not null)
                    {
                        foreach (var parameter in parameters)
                        {
                            arguments[parameter.Key] = parameter.Value;
                        }
                    }
                }

                using var returned = instance.InvokeMethod(
                    methodName,
                    arguments,
                    new InvokeMethodOptions());

                var returnValue = returned?["ReturnValue"];
                results.Add(new WmiMethodResult
                {
                    InstancePath = path,
                    ReturnValue = returnValue is null ? 0u : Convert.ToUInt32(returnValue),
                    Output = returned is null ? null : ToRecord(returned),
                });
            }
            catch (ManagementException e)
            {
                _logger.LogWarning(
                    e,
                    "WMI method {Method} failed on {InstancePath}.",
                    methodName,
                    path);

                // A failure on one adapter or volume must not abandon the rest.
                results.Add(new WmiMethodResult
                {
                    InstancePath = path,
                    ReturnValue = unchecked((uint)e.ErrorCode),
                });
            }
            finally
            {
                arguments?.Dispose();
            }
        }

        return results;
    }

    private static WmiRecord ToRecord(ManagementBaseObject managementObject)
    {
        var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);

        foreach (var property in managementObject.Properties)
        {
            try
            {
                values[property.Name] = property.Value;
            }
            catch (ManagementException)
            {
                // Individual properties can be unreadable on some providers.
                // Leaving the key absent reports it as unknown, which is true.
                values[property.Name] = null;
            }
        }

        return new WmiRecord(values);
    }
}

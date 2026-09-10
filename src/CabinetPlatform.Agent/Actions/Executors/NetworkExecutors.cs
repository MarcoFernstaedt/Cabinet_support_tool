using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// Flushes the DNS resolver cache.
/// </summary>
/// <remarks>
/// Through <c>DnsFlushResolverCache</c>, not by running <c>ipconfig</c>. The
/// difference is not stylistic: shelling out would give the agent a general
/// mechanism for launching programs, and the agent's safety rests on not having
/// one.
/// </remarks>
public sealed class FlushDnsCacheExecutor : IActionExecutor
{
    private readonly INativeSystemGateway _native;
    private readonly ILogger<FlushDnsCacheExecutor> _logger;

    public FlushDnsCacheExecutor(INativeSystemGateway native, ILogger<FlushDnsCacheExecutor> logger)
    {
        _native = native;
        _logger = logger;
    }

    public ActionName Action => ActionName.FlushDnsCache;

    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        // This action takes no parameters at all, so any is a disagreement
        // about what was asked for.
        if (!ActionParameters.TryValidateNoUnknownParameters(request, Array.Empty<string>(), out var unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        try
        {
            _native.FlushDnsResolverCache();
            _logger.LogInformation("The DNS resolver cache was flushed.");

            return Task.FromResult(ActionOutcome.Succeeded("The DNS resolver cache was flushed."));
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "The DNS resolver cache could not be flushed.");
            return Task.FromResult(ActionOutcome.Failed($"The DNS resolver cache could not be flushed. {e.Message}"));
        }
    }
}

/// <summary>
/// Renews the DHCP lease on every DHCP-enabled adapter.
/// </summary>
/// <remarks>
/// Briefly interrupts connectivity, which is why it is listed as disruptive.
/// It goes through <c>Win32_NetworkAdapterConfiguration.RenewDHCPLease</c>, and
/// only adapters that actually use DHCP are touched: renewing a lease on a
/// statically addressed adapter is meaningless, and on a cabinet with a fixed
/// address it would be an alarming thing to attempt.
/// </remarks>
public sealed class RenewDhcpLeaseExecutor : IActionExecutor
{
    private readonly IWmiRepository _wmi;
    private readonly ILogger<RenewDhcpLeaseExecutor> _logger;

    public RenewDhcpLeaseExecutor(IWmiRepository wmi, ILogger<RenewDhcpLeaseExecutor> logger)
    {
        _wmi = wmi;
        _logger = logger;
    }

    public ActionName Action => ActionName.RenewDhcpLease;

    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, Array.Empty<string>(), out var unknownFailure))
        {
            return Task.FromResult(ActionOutcome.Denied(unknownFailure));
        }

        const string DhcpAdapterQuery =
            "SELECT * FROM Win32_NetworkAdapterConfiguration WHERE DHCPEnabled = TRUE AND IPEnabled = TRUE";

        try
        {
            var adapters = _wmi.Query(WmiScopes.CimV2, DhcpAdapterQuery);
            if (adapters.Count == 0)
            {
                // Not a failure. There was simply nothing to renew.
                return Task.FromResult(ActionOutcome.Succeeded(
                    "No DHCP-enabled adapters are present on this cabinet, so no lease was renewed."));
            }

            var results = _wmi.InvokeMethod(WmiScopes.CimV2, DhcpAdapterQuery, "RenewDHCPLease");

            var succeeded = results.Count(result => result.Succeeded);
            var failed = results.Count - succeeded;

            _logger.LogInformation(
                "Renewed the DHCP lease on {SucceededCount} adapter(s); {FailedCount} failed.",
                succeeded,
                failed);

            if (succeeded == 0)
            {
                return Task.FromResult(ActionOutcome.Failed(
                    $"The DHCP lease could not be renewed on any of the {results.Count} DHCP-enabled adapter(s)."));
            }

            var summary = failed == 0
                ? $"The DHCP lease was renewed on all {succeeded} DHCP-enabled adapter(s)."
                : $"The DHCP lease was renewed on {succeeded} adapter(s); {failed} did not renew.";

            return Task.FromResult(ActionOutcome.Succeeded(summary));
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "The DHCP lease renewal failed.");
            return Task.FromResult(ActionOutcome.Failed($"The DHCP lease renewal failed. {e.Message}"));
        }
    }
}

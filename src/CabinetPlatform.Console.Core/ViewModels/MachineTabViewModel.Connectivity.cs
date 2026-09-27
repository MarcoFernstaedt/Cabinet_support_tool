using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.ViewModels;

public sealed partial class MachineTabViewModel
{
    private ConnectivityStatusDto? _connectivity;
    private string? _connectivityError;

    public string ConnectivityNote => _connectivityError is not null
        ? "Connectivity unknown: " + _connectivityError
        : _connectivity is null ? "Connectivity unknown; no observation has been loaded."
        : _connectivity.Links.Count == 0 ? "No active connectivity targets configured. This is not evidence of a healthy site."
        : "Registered same-site ICMP observations, not application sync health or a firewall diagnosis. " +
          "Times are MST (UTC−7). Stale means current reachability is unknown. Refresh retrieves new evidence.";

    public IReadOnlyList<string> ConnectivityRows => (_connectivity?.Links ?? []).Select(link =>
    {
        var now = _timeProvider.GetUtcNow();
        bool stale = link.IsStale || link.ObservedUtc is null || link.ObservedUtc < now.AddMinutes(-5) || link.ObservedUtc > now;
        return $"{(link.IsSync ? "Sync" : "Peer")} cabinet {link.TargetCabinetId}: " +
            (stale ? $"STALE / UNKNOWN now; last classification {link.Condition}. " : $"Last classification {link.Condition}. ") +
            $"Observed {SupportTime(link.ObservedUtc)}; received {SupportTime(link.ReceivedUtc)}; last reply {SupportTime(link.LastSuccessUtc)}. " +
            $"Consecutive failures {link.ConsecutiveFailures}; incident {(link.IncidentOpen ? "OPEN" : "not open")}; " +
            $"threshold observed {SupportTime(link.IncidentObservedUtc)}; recovery evidenced by {SupportTime(link.RecoveredObservedUtc)}.";
    }).ToArray();

    private static string SupportTime(DateTimeOffset? value) => value is null ? "unknown" : CabinetPlatform.Console.Core.Presentation.Format.LocalTime(value);

    private void ClearConnectivity()
    {
        _connectivity = null;
        _connectivityError = null;
        NotifyConnectivity();
    }

    private void NotifyConnectivity()
    {
        OnPropertyChanged(nameof(ConnectivityRows));
        OnPropertyChanged(nameof(ConnectivityNote));
    }
}

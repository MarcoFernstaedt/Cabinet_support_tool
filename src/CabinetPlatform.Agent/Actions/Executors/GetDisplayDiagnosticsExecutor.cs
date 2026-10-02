using System.Text.Json;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>Parameterless, read-only display mode observation; user-session settings are not inferred.</summary>
public sealed class GetDisplayDiagnosticsExecutor(IDisplayModeGateway gateway, IClock clock) : IActionExecutor
{
    private const int MaxModes = 8;
    public ActionName Action => ActionName.GetDisplayDiagnostics;

    public Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, Array.Empty<string>(), out string failure))
            return Task.FromResult(ActionOutcome.Denied("Display diagnostics accepts no parameters."));

        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<NativeDisplayMode> native;
        DisplayModeStatus status;
        try
        {
            native = gateway.ReadModes(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            status = native.Count == 0 ? DisplayModeStatus.Unavailable : DisplayModeStatus.Observed;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (UnauthorizedAccessException)
        {
            native = Array.Empty<NativeDisplayMode>();
            status = DisplayModeStatus.Denied;
        }
        catch (Exception)
        {
            native = Array.Empty<NativeDisplayMode>();
            status = DisplayModeStatus.Unavailable;
        }

        var modes = native.Take(MaxModes)
            .Select((mode, index) => new DisplayModeObservation
            {
                DisplayIndex = index,
                WidthPixels = mode.WidthPixels,
                HeightPixels = mode.HeightPixels,
                RefreshHz = mode.RefreshHz
            }).ToArray();
        var result = new DisplayDiagnostics
        {
            ObservedAtUtc = clock.UtcNow.ToUniversalTime(),
            ModeStatus = status,
            Modes = modes,
            ModesTruncated = native.Count > MaxModes,
            ScalingStatus = DisplaySessionStatus.InteractiveSessionInaccessible,
            ScalingPercent = null,
            MagnifierStatus = DisplaySessionStatus.InteractiveSessionInaccessible,
            AppZoomStatus = DisplaySessionStatus.NotCollected
        };
        return Task.FromResult(ActionOutcome.Collected(
            "Display mode observation: " + status + ". Interactive session settings not measured.",
            JsonSerializer.Serialize(result, AgentJson.SerializerOptions)));
    }
}

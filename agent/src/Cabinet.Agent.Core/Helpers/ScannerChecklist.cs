using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Helpers;

/// <summary>What Windows reports about one Plug and Play device.</summary>
public sealed record DeviceFacts
{
    public required string InstanceId { get; init; }
    public required string Name { get; init; }
    public string? Class { get; init; }
    public required bool Present { get; init; }
    public string? Status { get; init; }
    public long? ProblemCode { get; init; }
    public IReadOnlyList<string> HardwareIds { get; init; } = Array.Empty<string>();
    public string? LocationInfo { get; init; }
    public DriverFacts? Driver { get; init; }
}

public sealed record DriverFacts(string Name, string? Version, DateTimeOffset? Date, string? Signer);

/// <summary>Everything the scanner checks look at, gathered by the Windows executor.</summary>
public sealed record ScannerFacts
{
    public required IReadOnlyList<string> ConfiguredHardwareIds { get; init; }
    public required IReadOnlyList<DeviceFacts> Devices { get; init; }
    /// <summary>Whether USB selective suspend is on for the scanner; null when unknown.</summary>
    public bool? SelectiveSuspendEnabled { get; init; }
    /// <summary>How many times the scanner started in the last 24 hours (Kernel-PnP event 410); null when unknown.</summary>
    public int? StartsLast24Hours { get; init; }
    /// <summary>"running", "stopped", "absent", or null when unknown.</summary>
    public string? BiometricServiceState { get; init; }
}

/// <summary>
/// The standard fingerprint-scanner troubleshooting steps, automated: is it
/// plugged in, does Windows report an error, is a signed driver installed, can
/// USB power saving turn it off, does it keep reconnecting (a loose cable or a
/// bad port), does a USB controller or hub report a problem, and is the
/// Windows Biometric Service running. Each check says what to try next.
/// </summary>
public static class ScannerChecklist
{
    public const int ReconnectWarningThreshold = 3;

    public static PeripheralStatusOutput Evaluate(ScannerFacts facts)
    {
        bool configured = facts.ConfiguredHardwareIds.Count > 0;
        DeviceFacts? scanner = configured ? Find(facts) : null;
        var checks = new List<PeripheralCheck>
        {
            DevicePresent(configured, scanner),
            NoDeviceError(scanner),
            DriverInstalled(scanner),
            DriverSigned(scanner),
            PowerSaving(scanner, facts.SelectiveSuspendEnabled),
            Reconnects(scanner, facts.StartsLast24Hours),
            UsbControllers(facts.Devices),
            BiometricService(facts.BiometricServiceState),
        };
        return new PeripheralStatusOutput
        {
            Configured = configured,
            Connected = scanner?.Present ?? false,
            Name = scanner is null ? null : EventText.ShortText(scanner.Name),
            Status = scanner?.Status is { } s ? EventText.ShortText(s) : null,
            ErrorCode = scanner?.ProblemCode is > 0 ? scanner.ProblemCode : null,
            ErrorText = scanner is null ? null : DeviceProblems.Describe(scanner.ProblemCode),
            HardwareIds = scanner?.HardwareIds.Take(32).ToList() ?? new List<string>(),
            Driver = scanner?.Driver is { } d ? new PeripheralDriver { Name = EventText.ShortText(d.Name), Version = d.Version, Date = d.Date, Signer = d.Signer } : null,
            LocationInfo = scanner?.LocationInfo is { } l ? EventText.ShortText(l) : null,
            Checks = checks,
            Candidates = scanner is null ? Candidates(facts.Devices) : Array.Empty<PeripheralCandidate>(),
        };
    }

    /// <summary>The device whose hardware IDs include a configured one; a connected match wins over a remembered one.</summary>
    internal static DeviceFacts? Find(ScannerFacts facts) =>
        facts.Devices
            .Where(d => d.HardwareIds.Any(id => facts.ConfiguredHardwareIds.Contains(id, StringComparer.OrdinalIgnoreCase)))
            .OrderByDescending(d => d.Present)
            .FirstOrDefault();

    /// <summary>Likely scanners: the Biometric device class, or a name that says fingerprint or biometric.</summary>
    internal static IReadOnlyList<PeripheralCandidate> Candidates(IReadOnlyList<DeviceFacts> devices) =>
        devices
            .Where(d => string.Equals(d.Class, "Biometric", StringComparison.OrdinalIgnoreCase) ||
                        d.Name.Contains("fingerprint", StringComparison.OrdinalIgnoreCase) ||
                        d.Name.Contains("finger print", StringComparison.OrdinalIgnoreCase) ||
                        d.Name.Contains("biometric", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(d => d.Present)
            .Take(32)
            .Select(d => new PeripheralCandidate
            {
                InstanceId = d.InstanceId, Name = EventText.ShortText(d.Name), Class = d.Class, Connected = d.Present,
                Status = d.Status, HardwareIds = d.HardwareIds.Take(32).ToList(),
            })
            .ToList();

    private static PeripheralCheck Check(PeripheralCheckId id, PeripheralCheckOutcome outcome, string summary) =>
        new() { Check = id, Outcome = outcome, Summary = EventText.ShortText(summary) };

    private static PeripheralCheck DevicePresent(bool configured, DeviceFacts? scanner) => (configured, scanner) switch
    {
        (false, _) => Check(PeripheralCheckId.DevicePresent, PeripheralCheckOutcome.Unknown,
            "No scanner hardware IDs are configured on this cabinet; see the candidate devices."),
        (true, null) => Check(PeripheralCheckId.DevicePresent, PeripheralCheckOutcome.Fail,
            "Windows has never seen a scanner with the configured hardware IDs. Check the cable and try a different USB port."),
        (true, { Present: false }) => Check(PeripheralCheckId.DevicePresent, PeripheralCheckOutcome.Fail,
            "The scanner is not connected now. Reseat the cable, then try a different USB port."),
        _ => Check(PeripheralCheckId.DevicePresent, PeripheralCheckOutcome.Pass, "The scanner is connected."),
    };

    private static PeripheralCheck NoDeviceError(DeviceFacts? scanner) => scanner switch
    {
        null or { Present: false } => Check(PeripheralCheckId.NoDeviceError, PeripheralCheckOutcome.Unknown, "Not checked: the scanner is not connected."),
        { ProblemCode: > 0 } => Check(PeripheralCheckId.NoDeviceError, PeripheralCheckOutcome.Fail, DeviceProblems.Describe(scanner.ProblemCode)!),
        _ => Check(PeripheralCheckId.NoDeviceError, PeripheralCheckOutcome.Pass, "Windows reports no problem with the scanner."),
    };

    private static PeripheralCheck DriverInstalled(DeviceFacts? scanner) => scanner switch
    {
        null => Check(PeripheralCheckId.DriverInstalled, PeripheralCheckOutcome.Unknown, "Not checked: the scanner was not found."),
        { Driver: null } => Check(PeripheralCheckId.DriverInstalled, PeripheralCheckOutcome.Fail, "No driver is installed for the scanner."),
        { Driver: var d } => Check(PeripheralCheckId.DriverInstalled, PeripheralCheckOutcome.Pass,
            $"Driver {d!.Name}{(d.Version is null ? "" : $" {d.Version}")} is installed."),
    };

    private static PeripheralCheck DriverSigned(DeviceFacts? scanner) => scanner?.Driver switch
    {
        null => Check(PeripheralCheckId.DriverSigned, PeripheralCheckOutcome.Unknown, "Not checked: no driver was found."),
        { Signer: { Length: > 0 } signer } => Check(PeripheralCheckId.DriverSigned, PeripheralCheckOutcome.Pass, $"The driver is signed by {signer}."),
        _ => Check(PeripheralCheckId.DriverSigned, PeripheralCheckOutcome.Fail, "The driver has no valid signature. Reinstall the approved driver package."),
    };

    private static PeripheralCheck PowerSaving(DeviceFacts? scanner, bool? suspend) => (scanner, suspend) switch
    {
        (null, _) or (_, null) => Check(PeripheralCheckId.UsbPowerSaving, PeripheralCheckOutcome.Unknown, "USB power saving for the scanner could not be read."),
        (_, true) => Check(PeripheralCheckId.UsbPowerSaving, PeripheralCheckOutcome.Warn,
            "USB selective suspend is on for the scanner, so Windows may switch it off when idle."),
        _ => Check(PeripheralCheckId.UsbPowerSaving, PeripheralCheckOutcome.Pass, "USB power saving will not switch the scanner off."),
    };

    private static PeripheralCheck Reconnects(DeviceFacts? scanner, int? starts) => (scanner, starts) switch
    {
        (null, _) or (_, null) => Check(PeripheralCheckId.RecentReconnects, PeripheralCheckOutcome.Unknown, "Recent reconnects could not be counted."),
        (_, >= ReconnectWarningThreshold + 1) => Check(PeripheralCheckId.RecentReconnects, PeripheralCheckOutcome.Warn,
            $"The scanner reconnected {starts - 1} times in the last 24 hours, which points to a loose cable or a failing USB port."),
        _ => Check(PeripheralCheckId.RecentReconnects, PeripheralCheckOutcome.Pass, "No repeated reconnects in the last 24 hours."),
    };

    private static PeripheralCheck UsbControllers(IReadOnlyList<DeviceFacts> devices)
    {
        var failing = devices.Where(d => d.Present && d.ProblemCode is > 0 &&
            (string.Equals(d.Class, "USB", StringComparison.OrdinalIgnoreCase) || d.InstanceId.StartsWith("USB\\ROOT_HUB", StringComparison.OrdinalIgnoreCase)))
            .ToList();
        return failing.Count == 0
            ? Check(PeripheralCheckId.UsbControllerErrors, PeripheralCheckOutcome.Pass, "No USB controller or hub reports a problem.")
            : Check(PeripheralCheckId.UsbControllerErrors, PeripheralCheckOutcome.Fail,
                $"{failing.Count} USB controller or hub device(s) report a problem, starting with {failing[0].Name}. Try a port on a different controller.");
    }

    private static PeripheralCheck BiometricService(string? state) => state switch
    {
        "running" => Check(PeripheralCheckId.BiometricService, PeripheralCheckOutcome.Pass, "The Windows Biometric Service is running."),
        "stopped" => Check(PeripheralCheckId.BiometricService, PeripheralCheckOutcome.Warn,
            "The Windows Biometric Service is stopped. Scanners that use Windows biometrics need it running."),
        "absent" => Check(PeripheralCheckId.BiometricService, PeripheralCheckOutcome.Unknown, "The Windows Biometric Service is not installed."),
        _ => Check(PeripheralCheckId.BiometricService, PeripheralCheckOutcome.Unknown, "The Windows Biometric Service state could not be read."),
    };
}

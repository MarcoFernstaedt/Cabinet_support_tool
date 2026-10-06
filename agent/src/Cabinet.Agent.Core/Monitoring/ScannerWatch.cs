using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>
/// The fingerprint scanner watcher (docs/spec/04-agent-spec.md): each look at the
/// device list is compared with the last, and an event is raised when the scanner
/// develops a problem and again when it recovers. A problem that stays the same
/// is not repeated.
/// </summary>
public sealed class ScannerWatch
{
    public enum Condition { Ok, Disconnected, DeviceError, DriverMissing }

    private const long NoDriver = 28;
    private const long NotConnected = 45;
    private Condition? _last;
    private long? _lastProblem;
    private string? _lastIds;

    public static Condition Classify(DeviceFacts? scanner) => scanner switch
    {
        null or { Present: false } or { ProblemCode: NotConnected } => Condition.Disconnected,
        { ProblemCode: NoDriver } => Condition.DriverMissing,
        { ProblemCode: > 0 } => Condition.DeviceError,
        _ => Condition.Ok,
    };

    /// <summary>One look at the devices. Returns the event to raise, if any.</summary>
    /// <param name="configured">The scanner's hardware IDs; with none the watcher stays quiet (there is nothing to watch).</param>
    public AgentEvent? Observe(IReadOnlyList<string>? configured, IReadOnlyList<DeviceFacts> devices, DateTimeOffset now)
    {
        if (configured is not { Count: > 0 }) { _last = null; _lastIds = null; return null; }
        string ids = string.Join('|', configured).ToUpperInvariant();
        if (ids != _lastIds) { _last = null; _lastIds = ids; } // new IDs from the console: start again

        DeviceFacts? scanner = ScannerChecklist.Find(new ScannerFacts { ConfiguredHardwareIds = configured, Devices = devices });
        Condition now_ = Classify(scanner);
        Condition? before = _last;
        long? problemBefore = _lastProblem;
        _last = now_;
        _lastProblem = scanner?.ProblemCode;

        if (now_ == Condition.Ok)
            return before is null or Condition.Ok ? null : Build(configured, scanner, ScannerState.Recovered, now, before.Value);
        if (now_ == before && (now_ != Condition.DeviceError || problemBefore == scanner?.ProblemCode)) return null;
        ScannerState state = now_ switch
        {
            Condition.Disconnected => ScannerState.Disconnected,
            Condition.DriverMissing => ScannerState.DriverMissing,
            _ => ScannerState.DeviceError,
        };
        return Build(configured, scanner, state, now, before);
    }

    private static AgentEvent Build(IReadOnlyList<string> configured, DeviceFacts? scanner, ScannerState state, DateTimeOffset now, Condition? before)
    {
        string message = state switch
        {
            ScannerState.Recovered => $"The fingerprint scanner is working again (it was {Words(before!.Value)}).",
            ScannerState.Disconnected => scanner is null
                ? "No fingerprint scanner with the configured hardware IDs has been seen. Check the cable and try a different USB port."
                : "The fingerprint scanner is not connected. Reseat the cable, then try a different USB port.",
            ScannerState.DriverMissing => "No driver is installed for the fingerprint scanner.",
            _ => "Windows reports a problem with the fingerprint scanner. " + (DeviceProblems.Describe(scanner?.ProblemCode) ?? ""),
        };
        IReadOnlyList<string> ids = scanner?.HardwareIds is { Count: > 0 } found ? found.Take(16).ToList() : configured.Take(16).ToList();
        return new AgentEvent
        {
            EventId = Guid.NewGuid(),
            Kind = EventKind.Scanner,
            OccurredAt = now,
            SeverityHint = state == ScannerState.Recovered ? SeverityHint.Minor : SeverityHint.Major,
            Detail = new EventDetail { Message = EventText.LongText(message.Trim(), 32768) },
            Device = new ScannerDevice
            {
                HardwareIds = ids,
                DeviceInstanceId = scanner?.InstanceId,
                Name = scanner?.Name,
                State = state,
                ProblemCode = scanner?.ProblemCode is > 0 and <= uint.MaxValue ? scanner.ProblemCode : null,
            },
        };
    }

    private static string Words(Condition c) => c switch
    {
        Condition.Disconnected => "disconnected",
        Condition.DriverMissing => "missing its driver",
        _ => "reporting a device error",
    };
}

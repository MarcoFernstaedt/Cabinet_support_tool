using System.Text.Json;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Tests.Actions;

public sealed class DisplayDiagnosticsTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);

    [Fact]
    public async Task Observed_modes_have_only_bounded_numeric_fields_and_unknown_session_facts()
    {
        var gateway = new FakeGateway([new(1920, 1080, 60), new(1280, 720, null)]);
        var outcome = await new GetDisplayDiagnosticsExecutor(gateway, new FixedClock()).ExecuteAsync(Request(), default);
        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        using var doc = JsonDocument.Parse(outcome.CollectedData!);
        var root = doc.RootElement;
        Assert.Equal(new[] { "observedAtUtc", "modeStatus", "modes", "modesTruncated", "scalingStatus", "scalingPercent", "magnifierStatus", "appZoomStatus" },
            root.EnumerateObject().Select(p => p.Name));
        Assert.Equal("Observed", root.GetProperty("modeStatus").GetString());
        Assert.Equal(Now, root.GetProperty("observedAtUtc").GetDateTimeOffset());
        var rows = root.GetProperty("modes").EnumerateArray().ToArray();
        Assert.Equal(2, rows.Length);
        Assert.Equal(0, rows[0].GetProperty("displayIndex").GetInt32());
        Assert.Equal(1920, rows[0].GetProperty("widthPixels").GetInt32());
        Assert.Equal(60, rows[0].GetProperty("refreshHz").GetInt32());
        Assert.Equal(1, rows[1].GetProperty("displayIndex").GetInt32());
        Assert.False(rows[1].TryGetProperty("refreshHz", out _));
        Assert.Equal("InteractiveSessionInaccessible", root.GetProperty("scalingStatus").GetString());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("scalingPercent").ValueKind);
        Assert.Equal("InteractiveSessionInaccessible", root.GetProperty("magnifierStatus").GetString());
        Assert.Equal("NotCollected", root.GetProperty("appZoomStatus").GetString());
        Assert.False(root.GetProperty("modesTruncated").GetBoolean());
    }

    [Fact]
    public async Task Empty_or_unsupported_native_source_is_unavailable()
    {
        foreach (var gateway in new IDisplayModeGateway[]
        {
            new FakeGateway([]), new ThrowingGateway(new PlatformNotSupportedException())
        })
        {
            var result = await Execute(gateway);
            Assert.Equal(DisplayModeStatus.Unavailable, result.ModeStatus);
            Assert.Empty(result.Modes);
            Assert.Null(result.ScalingPercent);
        }
        if (!OperatingSystem.IsWindows())
            Assert.Empty(new WindowsDisplayModeGateway().ReadModes(default)); // No native Windows acceptance here.
    }

    [Fact]
    public async Task Access_denial_is_distinct_and_does_not_emit_native_exception_text()
    {
        var outcome = await new GetDisplayDiagnosticsExecutor(
            new ThrowingGateway(new UnauthorizedAccessException("sensitive device name")), new FixedClock())
            .ExecuteAsync(Request(), default);
        var result = JsonSerializer.Deserialize<DisplayDiagnostics>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        Assert.Equal(DisplayModeStatus.Denied, result.ModeStatus);
        Assert.Empty(result.Modes);
        Assert.DoesNotContain("sensitive", outcome.CollectedData! + outcome.Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task More_than_eight_modes_are_explicitly_truncated()
    {
        var result = await Execute(new FakeGateway(Enumerable.Range(0, 12)
            .Select(_ => new NativeDisplayMode(1024, 768, 75)).ToArray()));
        Assert.Equal(8, result.Modes.Count);
        Assert.True(result.ModesTruncated);
        Assert.Equal(Enumerable.Range(0, 8), result.Modes.Select(m => m.DisplayIndex));
    }

    [Fact]
    public async Task Cancellation_is_propagated_and_never_reported_as_unavailable()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new GetDisplayDiagnosticsExecutor(new FakeGateway([]), new FixedClock())
                .ExecuteAsync(Request(), cts.Token));
        using var afterRead = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new GetDisplayDiagnosticsExecutor(new CancelingGateway(afterRead), new FixedClock())
                .ExecuteAsync(Request(), afterRead.Token));
    }

    [Fact]
    public async Task Parameters_are_denied_before_any_native_read()
    {
        var gateway = new CountingGateway();
        var outcome = await new GetDisplayDiagnosticsExecutor(gateway, new FixedClock()).ExecuteAsync(
            Request() with { Parameters = new Dictionary<string, string> { ["display"] = "secret" } }, default);
        Assert.Equal(ActionStatus.Denied, outcome.Status);
        Assert.Null(outcome.CollectedData);
        Assert.Equal(0, gateway.Calls);
        Assert.DoesNotContain("secret", outcome.Output!, StringComparison.Ordinal);
        Assert.True(MonitoringBoundary.IsObservation(ActionName.GetDisplayDiagnostics));
    }

    private static async Task<DisplayDiagnostics> Execute(IDisplayModeGateway gateway)
    {
        var outcome = await new GetDisplayDiagnosticsExecutor(gateway, new FixedClock()).ExecuteAsync(Request(), default);
        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        return JsonSerializer.Deserialize<DisplayDiagnostics>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
    }

    private static ActionRequestDto Request() => new()
    {
        Id = Guid.NewGuid(), CabinetId = Guid.NewGuid(), Action = ActionName.GetDisplayDiagnostics,
        Reason = "Synthetic display observation", RequestedUtc = Now, RequestedByUserId = Guid.NewGuid()
    };

    private sealed class FixedClock : IClock { public DateTimeOffset UtcNow => Now; }
    private sealed class FakeGateway(IReadOnlyList<NativeDisplayMode> modes) : IDisplayModeGateway
    {
        public IReadOnlyList<NativeDisplayMode> ReadModes(CancellationToken cancellationToken) => modes;
    }
    private sealed class ThrowingGateway(Exception failure) : IDisplayModeGateway
    {
        public IReadOnlyList<NativeDisplayMode> ReadModes(CancellationToken cancellationToken) => throw failure;
    }
    private sealed class CancelingGateway(CancellationTokenSource source) : IDisplayModeGateway
    {
        public IReadOnlyList<NativeDisplayMode> ReadModes(CancellationToken cancellationToken)
        { source.Cancel(); return [new NativeDisplayMode(1920, 1080, 60)]; }
    }
    private sealed class CountingGateway : IDisplayModeGateway
    {
        public int Calls { get; private set; }
        public IReadOnlyList<NativeDisplayMode> ReadModes(CancellationToken cancellationToken)
        { Calls++; return []; }
    }
}

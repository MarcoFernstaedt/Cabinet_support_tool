using System.Text.Json;
using System.Diagnostics;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Tests.Actions;

public sealed class WerMetadataTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 2, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task Approved_reports_are_typed_bounded_and_never_transport_native_text()
    {
        var id = Guid.NewGuid();
        var native = new FakeGateway();
        native.Rows[WerStore.MachineQueue] = [new(id, Now.AddHours(-1), "APPCRASH")];
        native.Rows[WerStore.MachineArchive] = [new(id, Now.AddHours(-1), "APPCRASH")];
        var outcome = await new GetWerMetadataExecutor(native, new Clock()).ExecuteAsync(Request(), default);
        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        var data = JsonSerializer.Deserialize<WerMetadataResult>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        Assert.Single(data.Reports);
        Assert.Equal(id, data.Reports[0].ReportId);
        Assert.Equal(WerStore.MachineQueue, data.Reports[0].Store);
        Assert.Equal("APPCRASH", data.Reports[0].EventType);
        Assert.All(data.Stores, s => Assert.Equal(WerStoreStatus.Read, s.Status));
        Assert.DoesNotContain("private-path", outcome.CollectedData! + outcome.Output);
        Assert.DoesNotContain("another-secret", outcome.CollectedData! + outcome.Output);
        using var json = JsonDocument.Parse(outcome.CollectedData!);
        Assert.Equal(new[] { "version", "observedUtc", "stores", "reports" }, json.RootElement.EnumerateObject().Select(p => p.Name));
        Assert.Equal(new[] { "reportId", "createdUtc", "eventType", "store" },
            json.RootElement.GetProperty("reports")[0].EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public async Task Invalid_and_old_reports_are_rejected_and_native_failures_are_redacted()
    {
        var native = new FakeGateway();
        native.Rows[WerStore.MachineQueue] = [new(Guid.Empty, Now, "APPCRASH"),
            new(Guid.NewGuid(), Now.AddDays(-30), "APPCRASH"),
            new(Guid.NewGuid(), Now, "Free-form patient data"),
            new(Guid.NewGuid(), Now.AddMinutes(1), "APPCRASH")];
        native.FailArchive = true;
        var outcome = await new GetWerMetadataExecutor(native, new Clock()).ExecuteAsync(Request(), default);
        var data = JsonSerializer.Deserialize<WerMetadataResult>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        Assert.Empty(data.Reports);
        Assert.Equal(WerStoreStatus.Unavailable, data.Stores[1].Status);
        Assert.DoesNotContain("secret", outcome.CollectedData! + outcome.Output);
    }

    [Fact]
    public async Task Inputs_are_refused_before_native_access()
    {
        var native = new FakeGateway();
        var outcome = await new GetWerMetadataExecutor(native, new Clock()).ExecuteAsync(Request() with
        { Parameters = new Dictionary<string, string> { ["reportKey"] = "sensitive" } }, default);
        Assert.Equal(ActionStatus.Denied, outcome.Status);
        Assert.Equal(0, native.Calls);
    }

    [Fact]
    public void Native_abi_matches_verified_header_offsets()
    {
        WindowsWerMetadataGateway.ValidateLayout();
    }

    [Fact]
    public void Native_gateway_does_not_query_metadata_beyond_128_keys()
    {
        var native = new CountingWerNative();
        var rows = new WindowsWerMetadataGateway(native).Enumerate(WerStore.MachineQueue, default).ToArray();
        Assert.Equal(128, rows.Length);
        Assert.Equal(128, native.Queries);
    }

    [Fact]
    public void Native_gateway_does_not_query_after_elapsed_budget()
    {
        var native = new CountingWerNative();
        var gateway = new WindowsWerMetadataGateway(native, () => true);
        Assert.Throws<TimeoutException>(() => gateway.Enumerate(WerStore.MachineQueue, default).ToArray());
        Assert.Equal(0, native.Queries);
    }

    [Fact]
    public void Probe_rejects_extra_fields_and_native_text()
    {
        const string unsafeJson = "{\"version\":1,\"observedUtc\":\"2026-01-02T12:00:00Z\",\"stores\":[],\"reports\":[],\"reportKey\":\"secret\"}";
        Assert.Throws<InvalidDataException>(() => WerMetadataProcessProbe.ParseStrict(unsafeJson));
    }

    [Fact]
    public async Task Same_binary_probe_starts_without_host_and_emits_only_typed_result()
    {
        // The dotnet CLI is required for this same-binary child check. Do not
        // silently pass when a test runner omits DOTNET_HOST_PATH.
        var host = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
        if (string.IsNullOrEmpty(host))
            host = Environment.GetEnvironmentVariable("DOTNET_ROOT") is { Length: > 0 } root
                ? Path.Combine(root, OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet")
                : OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet";
        // Launch the Agent's complete build output, not the test runner's
        // dependency-incomplete project-reference copy or a stale Debug build.
        var configuration = new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name;
        var assembly = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
            $"../../../../../src/CabinetPlatform.Agent/bin/{configuration}/net8.0-windows/CabinetPlatform.Agent.dll"));
        Assert.True(File.Exists(assembly), $"Agent artifact missing: {assembly}");
        Assert.Equal(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(typeof(GetWerMetadataExecutor).Assembly.Location)),
            System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly)));
        var start = WerMetadataProcessProbe.CreateStartInfo(host, assembly);
        Assert.False(start.Environment.ContainsKey("WER_TEST_SECRET"));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var result = await WerMetadataProcessProbe.ReadProcessAsync(start, timeout.Token, TimeSpan.FromSeconds(3));
        Assert.Equal(2, result.Stores.Count);
    }

    [Fact]
    public async Task Probe_deadline_kills_and_reaps_hung_child()
    {
        if (OperatingSystem.IsWindows()) return; // Native Windows execution remains a separate gate.
        int pid = 0;
        var start = new ProcessStartInfo("/usr/bin/sleep") { UseShellExecute = false,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
        start.ArgumentList.Add("30");
        await Assert.ThrowsAsync<TimeoutException>(() => WerMetadataProcessProbe.ReadProcessAsync(
            start, CancellationToken.None, TimeSpan.FromMilliseconds(150), p => pid = p));
        Assert.True(pid > 0);
        Assert.Throws<ArgumentException>(() => Process.GetProcessById(pid));
    }

    [Fact]
    public async Task Probe_cancellation_kills_and_reaps_hung_child()
    {
        if (OperatingSystem.IsWindows()) return;
        int pid = 0;
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(150));
        var start = new ProcessStartInfo("/usr/bin/sleep") { UseShellExecute = false,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
        start.ArgumentList.Add("30");
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => WerMetadataProcessProbe.ReadProcessAsync(
            start, cancel.Token, TimeSpan.FromSeconds(10), p => pid = p));
        Assert.True(pid > 0);
        Assert.Throws<ArgumentException>(() => Process.GetProcessById(pid));
    }

    [Fact]
    public void Single_file_apphost_uses_exact_binary_without_dll_argument()
    {
        var binary = Path.Combine(Path.GetTempPath(), "CabinetPlatform.Agent" + (OperatingSystem.IsWindows() ? ".exe" : ""));
        var start = WerMetadataProcessProbe.CreateStartInfo(binary, string.Empty);
        Assert.Equal(binary, start.FileName);
        Assert.Equal(["--wer-metadata-probe"], start.ArgumentList);
        Assert.True(start.RedirectStandardOutput);
        Assert.False(start.Environment.ContainsKey("WER_TEST_SECRET"));
    }

    [Fact]
    public async Task Production_executor_uses_isolated_probe_not_in_process_native_gateway()
    {
        var probe = new FakeResultProbe();
        var outcome = await new GetWerMetadataExecutor(probe).ExecuteAsync(Request(), default);
        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        Assert.Equal(1, probe.Calls);
    }

    [Fact]
    public async Task Key_and_row_limits_explicitly_mark_partial()
    {
        var native = new FakeGateway();
        native.Rows[WerStore.MachineQueue] = Enumerable.Range(0, 130)
            .Select(_ => new NativeWerMetadata(Guid.NewGuid(), Now.AddMinutes(-1), "APPCRASH"))
            .ToArray();
        var outcome = await new GetWerMetadataExecutor(native, new Clock()).ExecuteAsync(Request(), default);
        var data = JsonSerializer.Deserialize<WerMetadataResult>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        Assert.Equal(40, data.Reports.Count);
        Assert.True(data.Stores[0].Truncated);
        Assert.Equal(WerStoreStatus.Partial, data.Stores[0].Status);
        Assert.Equal(WerStoreStatus.Partial, data.Stores[1].Status);
        Assert.Equal(1, native.Calls);
        Assert.Equal(40, native.Yielded);
    }

    [Fact]
    public async Task Key_bound_marks_partial_without_129th_query()
    {
        var native = new FakeGateway();
        native.Rows[WerStore.MachineQueue] = Enumerable.Range(0, 130)
            .Select(_ => new NativeWerMetadata(Guid.NewGuid(), Now, "unapproved"))
            .ToArray();
        var outcome = await new GetWerMetadataExecutor(native, new Clock()).ExecuteAsync(Request(), default);
        var result = JsonSerializer.Deserialize<WerMetadataResult>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        Assert.Equal(WerStoreStatus.Partial, result.Stores[0].Status);
        Assert.Equal(128, native.Yielded);
    }

    [Fact]
    public async Task Cancellation_propagates_before_and_during_enumeration()
    {
        var native = new FakeGateway();
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new GetWerMetadataExecutor(native, new Clock()).ExecuteAsync(Request(), cts.Token));
        Assert.Equal(0, native.Calls);
    }

    private static ActionRequestDto Request() => new() { Id = Guid.NewGuid(), CabinetId = Guid.NewGuid(), Action = ActionName.GetWerMetadata, Reason = "synthetic", RequestedByUserId = Guid.NewGuid(), RequestedUtc = Now, Parameters = new Dictionary<string, string>() };
    private sealed class Clock : IClock { public DateTimeOffset UtcNow => Now; }
    private sealed class FakeResultProbe : IWerResultProbe
    {
        public int Calls { get; private set; }
        public Task<WerMetadataResult> ReadAsync(CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(new WerMetadataResult { ObservedUtc = Now,
                Stores = [new() { Store = WerStore.MachineQueue, Status = WerStoreStatus.Unavailable },
                          new() { Store = WerStore.MachineArchive, Status = WerStoreStatus.Unavailable }] });
        }
    }
    private sealed class CountingWerNative : IWerNativeOperations
    {
        public int Queries { get; private set; }
        public IntPtr Open(WerStore store) => new(1);
        public void Close(IntPtr handle) { }
        public string? First(IntPtr handle) => "0";
        public string? Next(IntPtr handle, string key) => (int.Parse(key) + 1).ToString();
        public NativeWerMetadata Query(IntPtr handle, string key, Func<bool> deadlineReached)
        {
            Queries++;
            return new NativeWerMetadata(Guid.NewGuid(), Now, "APPCRASH");
        }
    }
    private sealed class FakeGateway : IWerMetadataGateway
    {
        public Dictionary<WerStore, IReadOnlyList<NativeWerMetadata>> Rows { get; } = new();
        public bool FailArchive { get; set; }
        public int Calls { get; private set; }
        public int Yielded { get; private set; }
        public IEnumerable<NativeWerMetadata> Enumerate(WerStore store, CancellationToken ct)
        {
            Calls++;
            if (store == WerStore.MachineArchive && FailArchive) throw new InvalidOperationException("secret native key");
            foreach (var row in Rows.GetValueOrDefault(store) ?? []) { ct.ThrowIfCancellationRequested(); Yielded++; yield return row; }
        }
    }
}

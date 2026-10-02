using System.Text.Json;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Tests.Actions;

public sealed class HistoricalProcessEvidenceTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 2, 12, 0, 0, TimeSpan.Zero);
    private static ActionRequestDto Request() => new() { Id = Guid.NewGuid(), CabinetId = Guid.NewGuid(), Action = ActionName.GetHistoricalProcessEvidence, RequestedByUserId = Guid.NewGuid(), RequestedUtc = Now, Reason = "test", Parameters = new Dictionary<string, string>() };
    private sealed class Clock : IClock { public DateTimeOffset UtcNow => Now; }
    private sealed class Gateway : IHistoricalProcessGateway
    {
        public int Calls;
        public IEnumerable<NativeProcessEvent> Read(DateTimeOffset since, DateTimeOffset until, CancellationToken token)
        {
            Calls++;
            Assert.Equal(Now.AddDays(-1), since);
            Assert.Equal(Now, until);
            yield return new NativeProcessEvent(4688, "Microsoft-Windows-Security-Auditing", Now.AddHours(-1), "<Event><EventData><Data Name='NewProcessId'>0x1a</Data><Data Name='CommandLine'>secret-command</Data></EventData></Event>", 13);
            yield return new NativeProcessEvent(4689, "Microsoft-Windows-Security-Auditing", Now.AddMinutes(-1), "<Event><EventData><Data Name='ProcessId'>26</Data></EventData></Event>", 14);
            yield return new NativeProcessEvent(4688, "other-provider", Now, "<Event><EventData><Data Name='NewProcessId'>5</Data></EventData></Event>", 15);
        }
    }
    private sealed class GuardedGateway : IHistoricalProcessGateway
    {
        public int NativeReads { get; private set; }
        public IEnumerable<NativeProcessEvent> Read(DateTimeOffset since, DateTimeOffset until, CancellationToken token)
        {
            while (true)
            {
                NativeReads++;
                if (NativeReads > 64) throw new IOException("secret native 65th event");
                yield return Event(4688, "<Event><EventData><Data Name='NewProcessId'>0x1a</Data><Data Name='CommandLine'>secret-command</Data></EventData></Event>");
            }
        }
    }
    [Fact]
    public async Task Stops_before_reading_or_rendering_native_event_after_64_emitted_rows()
    {
        var gateway = new GuardedGateway();
        var outcome = await new GetHistoricalProcessEvidenceExecutor(gateway, new Clock()).ExecuteAsync(Request(), default);
        var result = JsonSerializer.Deserialize<HistoricalProcessEvidenceResult>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        Assert.Equal(64, gateway.NativeReads);
        Assert.Equal(64, result.Events.Count);
        Assert.Equal(ProcessEvidenceStatus.Partial, result.Status);
        Assert.True(result.Truncated);
        Assert.DoesNotContain("secret", outcome.CollectedData! + outcome.Output);
    }
    private sealed class SlowGateway : IHistoricalProcessGateway
    {
        public int NativeReads { get; private set; }
        public IEnumerable<NativeProcessEvent> Read(DateTimeOffset since, DateTimeOffset until, CancellationToken token)
        {
            NativeReads++;
            Thread.Sleep(TimeSpan.FromMilliseconds(3100));
            yield return Event(4688, "<Event><EventData><Data Name='NewProcessId'>1</Data></EventData></Event>");
            NativeReads++;
            throw new IOException("secret late read");
        }
    }
    [Fact]
    public async Task Does_not_advance_native_cursor_after_elapsed_deadline()
    {
        var gateway = new SlowGateway();
        var outcome = await new GetHistoricalProcessEvidenceExecutor(gateway, new Clock()).ExecuteAsync(Request(), default);
        var result = JsonSerializer.Deserialize<HistoricalProcessEvidenceResult>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        Assert.Equal(1, gateway.NativeReads);
        Assert.Empty(result.Events);
        Assert.Equal(ProcessEvidenceStatus.Partial, result.Status);
        Assert.True(result.Truncated);
        Assert.DoesNotContain("secret", outcome.CollectedData! + outcome.Output);
    }
    private sealed class RowsGateway(params NativeProcessEvent[] rows) : IHistoricalProcessGateway
    {
        public IEnumerable<NativeProcessEvent> Read(DateTimeOffset since, DateTimeOffset until, CancellationToken token) => rows;
    }
    private sealed class FailingGateway(Exception failure, NativeProcessEvent? initial = null) : IHistoricalProcessGateway
    {
        public IEnumerable<NativeProcessEvent> Read(DateTimeOffset since, DateTimeOffset until, CancellationToken token)
        {
            if (initial is not null) yield return initial;
            throw failure;
        }
    }
    private static NativeProcessEvent Event(int id, string xml, DateTimeOffset? when = null) =>
        new(id, "Microsoft-Windows-Security-Auditing", when ?? Now, xml, 2);
    private static async Task<HistoricalProcessEvidenceResult> Result(IHistoricalProcessGateway gateway)
    {
        var outcome = await new GetHistoricalProcessEvidenceExecutor(gateway, new Clock()).ExecuteAsync(Request(), default);
        return JsonSerializer.Deserialize<HistoricalProcessEvidenceResult>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
    }

    [Fact]
    public async Task Empty_read_is_not_historical_audit_coverage()
    {
        var result = await Result(new RowsGateway());
        Assert.Equal(ProcessEvidenceStatus.Read, result.Status);
        Assert.Empty(result.Events);
        Assert.Equal(Now.AddDays(-1), result.WindowStartUtc);
        Assert.False(result.AuditCoverageVerified);
    }
    [Theory]
    [InlineData("<!DOCTYPE Event [<!ENTITY leak SYSTEM 'file:///etc/passwd'>]><Event>&leak;</Event>")]
    [InlineData("<Event><EventData><Data Name='NewProcessId'>oops</Data></EventData></Event>")]
    [InlineData("<Event><EventData><Data Name='ProcessId'>1</Data></EventData>")]
    public async Task Bad_xml_and_pid_are_partial_without_rows(string xml)
    {
        var result = await Result(new RowsGateway(Event(4688, xml)));
        Assert.Equal(ProcessEvidenceStatus.Partial, result.Status);
        Assert.Empty(result.Events);
    }
    [Fact]
    public async Task Oversized_xml_and_outside_window_are_not_returned()
    {
        var result = await Result(new RowsGateway(Event(4688, "<Event>" + new string('x', 17000) + "</Event>"),
            Event(4689, "<Event><EventData><Data Name='ProcessId'>1</Data></EventData></Event>", Now.AddDays(-2))));
        Assert.Equal(ProcessEvidenceStatus.Partial, result.Status);
        Assert.Empty(result.Events);
    }
    [Fact]
    public async Task Denial_and_unavailability_do_not_look_like_zero_row_reads()
    {
        Assert.Equal(ProcessEvidenceStatus.Denied, (await Result(new FailingGateway(new UnauthorizedAccessException("secret")))).Status);
        Assert.Equal(ProcessEvidenceStatus.Unavailable, (await Result(new FailingGateway(new IOException("secret")))).Status);
    }
    [Fact]
    public async Task Limit_after_a_row_reports_partial_and_keeps_typed_row()
    {
        var valid = Event(4688, "<Event><EventData><Data Name='NewProcessId'>0xFF</Data></EventData></Event>");
        var result = await Result(new FailingGateway(new HistoricalProcessLimitException(), valid));
        Assert.Equal(ProcessEvidenceStatus.Partial, result.Status);
        Assert.True(result.Truncated);
        Assert.Equal(255u, Assert.Single(result.Events).ProcessId);
    }
    private sealed class FailingProbe(Exception failure) : IHistoricalProcessProbe
    {
        public Task<HistoricalProcessEvidenceResult> ReadAsync(CancellationToken token) => Task.FromException<HistoricalProcessEvidenceResult>(failure);
    }
    [Fact]
    public async Task Probe_failure_is_typed_without_native_error_text()
    {
        var outcome = await new GetHistoricalProcessEvidenceExecutor(new FailingProbe(new IOException("secret native path"))).ExecuteAsync(Request(), default);
        var result = JsonSerializer.Deserialize<HistoricalProcessEvidenceResult>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        Assert.Equal(ProcessEvidenceStatus.Unavailable, result.Status);
        Assert.Empty(result.Events);
        Assert.DoesNotContain("secret", outcome.CollectedData! + outcome.Output);
    }
    [Fact]
    public async Task Hung_native_child_is_killed_and_reaped()
    {
        if (!OperatingSystem.IsLinux()) return;
        var start = new System.Diagnostics.ProcessStartInfo("/bin/sh")
        {
            UseShellExecute = false, RedirectStandardOutput = true,
            RedirectStandardError = true, RedirectStandardInput = true
        };
        start.ArgumentList.Add("-c");
        start.ArgumentList.Add("sleep 30");
        int pid = 0;
        await Assert.ThrowsAsync<TimeoutException>(() => HistoricalProcessProbe.ReadProcessAsync(start,
            CancellationToken.None, TimeSpan.FromMilliseconds(100), value => pid = value));
        Assert.True(pid > 0);
        Assert.Throws<ArgumentException>(() => System.Diagnostics.Process.GetProcessById(pid));
    }
    [Fact]
    public void Probe_rejects_unexpected_sensitive_fields()
    {
        Assert.Throws<InvalidDataException>(() => HistoricalProcessProbe.ParseStrict("{\"version\":1,\"observedUtc\":\"2026-01-02T12:00:00Z\",\"windowStartUtc\":\"2026-01-01T12:00:00Z\",\"status\":\"Read\",\"truncated\":false,\"events\":[],\"commandLine\":\"secret\"}"));
    }
    [Fact]
    public async Task Reads_typed_start_and_exit_without_sensitive_payload()
    {
        var gateway = new Gateway();
        var outcome = await new GetHistoricalProcessEvidenceExecutor(gateway, new Clock()).ExecuteAsync(Request(), default);
        Assert.Equal(ActionStatus.Succeeded, outcome.Status);
        var result = JsonSerializer.Deserialize<HistoricalProcessEvidenceResult>(outcome.CollectedData!, AgentJson.SerializerOptions)!;
        Assert.Equal(ProcessEvidenceStatus.Partial, result.Status);
        Assert.Equal(2, result.Events.Count);
        Assert.Equal(ProcessEventKind.Start, result.Events[0].Kind);
        Assert.Equal(ProcessEventKind.Exit, result.Events[1].Kind);
        Assert.All(result.Events, row => Assert.Equal(26u, row.ProcessId));
        Assert.DoesNotContain("secret-command", outcome.CollectedData! + outcome.Output);
        Assert.DoesNotContain("CommandLine", outcome.CollectedData!);
        Assert.Equal(1, gateway.Calls);
    }
    [Fact]
    public async Task Rejects_parameters_before_read()
    {
        var gateway = new Gateway();
        var outcome = await new GetHistoricalProcessEvidenceExecutor(gateway, new Clock()).ExecuteAsync(Request() with { Parameters = new Dictionary<string, string> { ["pid"] = "1" } }, default);
        Assert.Equal(ActionStatus.Denied, outcome.Status);
        Assert.Equal(0, gateway.Calls);
    }
}

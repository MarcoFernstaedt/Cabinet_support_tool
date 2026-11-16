using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Core.Tests;

public sealed class LocalSessionsTests
{
    [Fact]
    public async Task Policy_certificate_and_second_session_refusals_are_reported_and_recorded_durably()
    {
        string folder = Path.Combine(AppContext.BaseDirectory, "sessions-" + Guid.NewGuid());
        string path = Path.Combine(folder, "sessions.jsonl");
        bool enabled = false, certificate = true;
        var sessions = new LocalSessions(path, () => enabled, () => certificate, TimeProvider.System);
        var input = new SessionOpenParams(Guid.NewGuid(), "diagnostic");
        try
        {
            Assert.Contains("policy", (await Assert.ThrowsAsync<OperationFailedException>(() => sessions.OpenAsync(input, CancellationToken.None))).Message);
            Assert.Null(sessions.Active);
            enabled = true; certificate = false;
            Assert.Contains("certificate", (await Assert.ThrowsAsync<OperationFailedException>(() => sessions.OpenAsync(input, CancellationToken.None))).Message);
            certificate = true;
            Assert.Equal(input.SessionId, (await sessions.OpenAsync(input, CancellationToken.None)).SessionId);
            Assert.Contains("already live", (await Assert.ThrowsAsync<OperationFailedException>(() => sessions.OpenAsync(input with { SessionId = Guid.NewGuid() }, CancellationToken.None))).Message);
            sessions.Close("Engineer finished");
            Assert.Null(sessions.Active);
            var restarted = new LocalSessions(path, () => enabled, () => certificate, TimeProvider.System);
            Assert.Null(restarted.Active);
            var lines = File.ReadAllLines(path);
            Assert.Equal(5, lines.Length);
            Assert.Contains("Engineer finished", lines[^1]);
            Assert.Contains(input.SessionId.ToString(), lines[2]);
        }
        finally { Directory.Delete(folder, true); }
    }
    [Fact]
    public async Task Local_policy_refusal_becomes_a_schema_valid_command_result_instead_of_a_silent_drop()
    {
        string folder = Path.Combine(AppContext.BaseDirectory, "session-result-" + Guid.NewGuid());
        var clock = new ManualClock(Fixtures.Start);
        var config = Fixtures.Config();
        var local = new LocalSessions(Path.Combine(folder, "sessions.jsonl"), () => config.SessionsEnabled, () => true, clock);
        var processor = new CommandProcessor(new CommandValidator(config, new ReplayStore(null, clock), new RateLimiter(null, clock), clock), new OperationRegistry(), clock);
        processor.RegisterSessionHandler(local.OpenAsync);
        var command = Fixtures.Command("session.open", new System.Text.Json.Nodes.JsonObject { ["sessionId"] = Guid.NewGuid().ToString(), ["kind"] = "diagnostic" });
        try
        {
            var (result, dropped) = await processor.ProcessAsync(Fixtures.Bytes(command), CancellationToken.None);
            Assert.Null(dropped);
            Assert.NotNull(result);
            Assert.Equal(ResultStatus.Failed, result.Status);
            Assert.Equal("unavailable", result.Error!.Code);
            Assert.Contains("policy", result.Error.Message);
            Assert.Null(local.Active);
            Assert.Contains("refused", File.ReadAllText(Path.Combine(folder, "sessions.jsonl")));
        }
        finally { Directory.Delete(folder, true); }
    }

    [Theory]
    [InlineData("policy")]
    [InlineData("certificate")]
    [InlineData("maximum")]
    public async Task Local_authorization_changes_and_absolute_maximum_close_before_another_exchange(string ending)
    {
        string folder = Path.Combine(AppContext.BaseDirectory, "session-expiry-" + Guid.NewGuid());
        var clock = new ManualClock(Fixtures.Start);
        bool policy = true, certificate = true;
        var sessions = new LocalSessions(Path.Combine(folder, "sessions.jsonl"), () => policy, () => certificate, clock);
        try
        {
            await sessions.OpenAsync(new SessionOpenParams(Guid.NewGuid(), "diagnostic"), CancellationToken.None);
            if (ending == "policy") policy = false;
            if (ending == "certificate") certificate = false;
            if (ending == "maximum") clock.Advance(TimeSpan.FromMinutes(30));
            // No API is needed: every local rejection must happen before a network call.
            await sessions.PollAsync(null!, CancellationToken.None);
            Assert.Null(sessions.Active);
            Assert.Contains("authorization expired", File.ReadAllText(Path.Combine(folder, "sessions.jsonl")));
        }
        finally { Directory.Delete(folder, true); }
    }

}

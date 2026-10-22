using System.IO.Pipes;
using static Cabinet.Agent.Core.Tests.Fixtures;

namespace Cabinet.Agent.Core.Tests;

public sealed class CommandProcessorTests
{
    private readonly ManualClock _clock = new(Start);

    private CommandProcessor Processor(OperationRegistry registry, TimeSpan? timeout = null) =>
        new(new CommandValidator(Config(), new ReplayStore(null, _clock), new RateLimiter(null, _clock), _clock), registry, _clock)
        { Timeout = timeout ?? TimeSpan.FromSeconds(5) };

    private static SystemInfoOutput Info() => new()
    {
        Hostname = "CAB-01", OsVersion = "Windows 10 IoT Enterprise LTSC", OsBuild = "19044.4651", UptimeSeconds = 10,
        AgentVersion = "0.1.0", ReadOnlyMode = false, CabinetRole = null, SerialNumber = null,
    };

    private static void AssertResultValid(Result result) =>
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Envelope("result"), JsonSerializer.SerializeToElement(result, ContractJson.Options)));

    [Fact]
    public async Task A_valid_command_runs_and_returns_schema_valid_output()
    {
        var registry = new OperationRegistry().Register<EmptyParams, SystemInfoOutput>(Catalog.SystemInfo, (_, _) => Task.FromResult(Info()));
        var (result, dropped) = await Processor(registry).ProcessAsync(Bytes(Command()), default);
        Assert.Null(dropped);
        Assert.Equal(ResultStatus.Succeeded, result!.Status);
        Assert.Equal("CAB-01", result.Output!.Value.GetProperty("hostname").GetString());
        AssertResultValid(result);
    }

    [Fact]
    public async Task An_output_that_breaks_its_contract_names_the_field_and_the_rule()
    {
        // A handler that answers with an empty object: hostname is required, so the refusal must say where and why.
        var registry = new OperationRegistry().RegisterRaw(Catalog.SystemInfo,
            (_, _) => Task.FromResult(JsonSerializer.SerializeToElement(new { }, ContractJson.Options)));
        var (output, error) = await OperationRunner.RunAsync(registry, Catalog.SystemInfo,
            JsonSerializer.SerializeToElement(new EmptyParams(), ContractJson.Options), TimeSpan.FromSeconds(5), default);
        Assert.Null(output);
        Assert.Equal("execution_failed", error!.Code);
        Assert.StartsWith("The operation produced output that does not match its contract at /", error.Message);
        Assert.Contains("rule required", error.Message);
    }

    [Fact]
    public void A_refusal_names_the_real_field_and_not_the_branches_a_oneOf_rejected()
    {
        // One branch per kind of value it refused, all at one path: noise from a oneOf that passed.
        var noise = new SchemaIssue("/snapshots/0/items/0/values/enabled", "type");
        var issues = new List<SchemaIssue> { new("/properties", "properties"), noise, noise, noise, noise };
        Assert.Equal("/properties (rule properties)", ContractSchemas.Refusal(issues));

        // A field the contract wanted as one kind of value and got another is reported on its own.
        Assert.Equal("/values/enabled (rule type)", ContractSchemas.Refusal([new SchemaIssue("/values/enabled", "type")]));

        // A oneOf that really failed reports itself beside its branches.
        Assert.Equal("/snapshots/0/items/0/values/enabled (rule oneOf)", ContractSchemas.Refusal([
            new SchemaIssue("/snapshots/0/items/0/values/enabled", "oneOf"), noise, noise, noise, noise,
        ]));

        Assert.Null(ContractSchemas.Refusal([]));
    }

    [Fact]
    public async Task A_rejected_command_never_reaches_the_handler()
    {
        bool ran = false;
        var registry = new OperationRegistry().Register<EmptyParams, SystemInfoOutput>(Catalog.SystemInfo, (_, _) => { ran = true; return Task.FromResult(Info()); });
        var (result, _) = await Processor(registry).ProcessAsync(Bytes(Command(cabinet: Guid.NewGuid())), default);
        Assert.Equal(ResultStatus.Rejected, result!.Status);
        Assert.Equal("wrong_cabinet", result.Error!.Code);
        Assert.False(ran);
        AssertResultValid(result);
    }

    [Fact]
    public async Task Write_operations_are_unavailable_in_this_milestone()
    {
        var (result, _) = await Processor(new OperationRegistry()).ProcessAsync(
            Bytes(Command("network.setDns", new JsonObject { ["interfaceIndex"] = 3, ["mode"] = "automatic" })), default);
        Assert.Equal(ResultStatus.Failed, result!.Status);
        Assert.Equal("unavailable", result.Error!.Code);
    }

    [Fact]
    public async Task Output_that_breaks_the_contract_is_not_sent()
    {
        var registry = new OperationRegistry().Register<EmptyParams, SystemInfoOutput>(Catalog.SystemInfo,
            (_, _) => Task.FromResult(Info() with { Hostname = "bad\u0001name" }));
        var (result, _) = await Processor(registry).ProcessAsync(Bytes(Command()), default);
        Assert.Equal("execution_failed", result!.Error!.Code);
        Assert.Null(result.Output);
    }

    [Fact]
    public async Task A_handler_that_hangs_times_out()
    {
        var registry = new OperationRegistry().Register<EmptyParams, SystemInfoOutput>(Catalog.SystemInfo,
            (_, _) => { Thread.Sleep(Timeout.Infinite); return Task.FromResult(Info()); });
        var (result, _) = await Processor(registry, TimeSpan.FromMilliseconds(200)).ProcessAsync(Bytes(Command()), default);
        Assert.Equal("timeout", result!.Error!.Code);
    }

    [Fact]
    public async Task Exception_text_from_the_system_is_not_passed_on()
    {
        var registry = new OperationRegistry().Register<EmptyParams, SystemInfoOutput>(Catalog.SystemInfo,
            (_, _) => throw new UnauthorizedAccessException(@"Access to C:\Users\nurse.jones\secret is denied"));
        var (result, _) = await Processor(registry).ProcessAsync(Bytes(Command()), default);
        Assert.Equal("execution_failed", result!.Error!.Code);
        Assert.DoesNotContain("nurse", result.Error.Message);
    }

    [Fact]
    public async Task A_handler_can_end_with_a_specific_failure_code()
    {
        var registry = new OperationRegistry().Register<EmptyParams, SystemInfoOutput>(Catalog.SystemInfo,
            (_, _) => throw new OperationFailedException("not_found", "No such entry."));
        var (result, _) = await Processor(registry).ProcessAsync(Bytes(Command()), default);
        Assert.Equal("not_found", result!.Error!.Code);
    }

    [Fact]
    public void Only_catalog_operations_with_matching_types_can_be_registered()
    {
        Assert.Throws<ArgumentException>(() => new OperationRegistry().RegisterRaw("shell.run", (p, _) => Task.FromResult(p)));
        Assert.Throws<ArgumentException>(() => new OperationRegistry().Register<EmptyParams, DiskSmartOutput>(Catalog.SystemInfo, (_, _) => Task.FromResult(new DiskSmartOutput { Drives = [] })));
    }
}

/// <summary>The broker conversation over a real named pipe (a Unix socket on Linux). Access control is tested on Windows.</summary>
public sealed class BrokerProtocolTests
{
    private static OperationRegistry BrokerOps() => new OperationRegistry()
        .Register<EventlogQueryParams, EventlogQueryOutput>(Catalog.EventlogQuery, (p, _) => Task.FromResult(new EventlogQueryOutput
        {
            Log = p.Log, NextBeforeRecordId = null, Truncated = false,
            Entries = [new EventSummary { RecordId = 9, Time = Start, Level = EventLevel.Error, Source = "disk", EventId = 7, FirstLine = "bad block" }],
        }));

    /// <summary>Runs a one-connection server that answers with <paramref name="answer"/>, or with the real handler.</summary>
    private static async Task<T> WithServer<T>(Func<byte[], Task<byte[]?>> answer, Func<BrokerClient, Task<T>> client)
    {
        string name = "cabinet-test-" + Guid.NewGuid().ToString("N");
        using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        Task serve = Task.Run(async () =>
        {
            await server.WaitForConnectionAsync();
            byte[]? request = await BrokerFraming.ReadAsync(server, BrokerFraming.MaxRequestBytes, default);
            if (request is not null && await answer(request) is { } reply) await BrokerFraming.WriteAsync(server, reply, default);
            server.Disconnect();
        });
        var broker = new BrokerClient(async token =>
        {
            var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            await pipe.ConnectAsync(5000, token);
            return pipe;
        });
        T result = await client(broker);
        await serve;
        return result;
    }

    [Fact]
    public async Task A_broker_operation_round_trips_and_the_output_is_checked()
    {
        var handler = new BrokerRequestHandler(BrokerOps());
        JsonElement output = await WithServer(r => handler.HandleAsync(r, default),
            c => c.RunAsync(Catalog.EventlogQuery, JsonSerializer.SerializeToElement(new { log = "System" }), default));
        Assert.Equal("bad block", output.GetProperty("entries")[0].GetProperty("firstLine").GetString());
    }

    [Fact]
    public async Task Ping_answers()
    {
        var handler = new BrokerRequestHandler(BrokerOps());
        Assert.True(await WithServer(r => handler.HandleAsync(r, default), c => c.PingAsync(default)));
    }

    [Fact]
    public async Task An_operation_the_broker_does_not_run_fails_as_unavailable()
    {
        var handler = new BrokerRequestHandler(BrokerOps());
        var e = await Assert.ThrowsAsync<OperationFailedException>(() => WithServer(r => handler.HandleAsync(r, default),
            c => c.RunAsync(Catalog.DiskSmart, JsonSerializer.SerializeToElement(new { }), default)));
        Assert.Equal("unavailable", e.Code);
    }

    public static IEnumerable<object[]> HostileRequests() => new[]
    {
        new object[] { """{"requestId":"5e1f7a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b","kind":"operation","operation":"network.test","params":{"target":"gateway","method":"ping"}}""" },
        new object[] { """{"requestId":"5e1f7a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b","kind":"operation","operation":"eventlog.query","params":{"log":"Security"}}""" },
        new object[] { """{"requestId":"5e1f7a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b","kind":"operation","operation":"shell.run","params":{"command":"whoami"}}""" },
        new object[] { """{"requestId":"5e1f7a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b","kind":"operation","operation":"files.list","params":{"path":"C:\\..\\x"}}""" },
        new object[] { """{"requestId":"5e1f7a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b","kind":"ping","run":"calc.exe"}""" },
        new object[] { """{"requestId":"5e1f7a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b","kind":"operation","operation":"eventlog.query","params":{"log":"System"},"params":{"log":"Security"}}""" },
    };

    [Theory]
    [MemberData(nameof(HostileRequests))]
    public async Task The_broker_validates_every_request_itself(string request)
    {
        bool ran = false;
        var registry = new OperationRegistry().Register<EventlogQueryParams, EventlogQueryOutput>(Catalog.EventlogQuery, (p, _) =>
        {
            ran = true;
            return Task.FromResult(new EventlogQueryOutput { Log = p.Log, Entries = [], NextBeforeRecordId = null, Truncated = false });
        });
        byte[]? reply = await new BrokerRequestHandler(registry).HandleAsync(Bytes(request), default);
        Assert.False(ran);
        if (reply is not null)
        {
            var response = JsonSerializer.Deserialize<BrokerResponse>(reply, ContractJson.Options)!;
            Assert.Equal(BrokerStatus.Failed, response.Status);
        }
    }

    [Theory]
    [InlineData("")]
    [InlineData("garbage")]
    [InlineData("{\"kind\":\"ping\"}")]
    [InlineData("[1,2,3]")]
    public async Task Unreadable_requests_get_no_answer(string request) =>
        Assert.Null(await new BrokerRequestHandler(BrokerOps()).HandleAsync(Bytes(request), default));

    [Fact]
    public void The_broker_refuses_to_be_given_a_non_broker_operation() =>
        Assert.Throws<ArgumentException>(() => new BrokerRequestHandler(new OperationRegistry()
            .Register<NetworkTestParams, NetworkTestOutput>(Catalog.NetworkTest, (_, _) => throw new NotSupportedException())));

    [Fact]
    public void The_handlers_operation_list_matches_the_broker_request_schema()
    {
        var schema = JsonNode.Parse(File.ReadAllText(Path.Combine(ContractsDir(), "schemas", "agent", "broker-request.schema.json")))!;
        var names = schema["properties"]!["operation"]!["enum"]!.AsArray().Select(n => n!.GetValue<string>()).Order();
        Assert.Equal(names, BrokerRequestHandler.Operations.Order());
    }

    [Fact]
    public async Task The_client_refuses_an_answer_to_a_different_request()
    {
        var e = await Assert.ThrowsAsync<OperationFailedException>(() => WithServer(
            _ => Task.FromResult<byte[]?>(Bytes($$$"""{"requestId":"{{{Guid.NewGuid()}}}","status":"succeeded","output":{"log":"System","entries":[],"nextBeforeRecordId":null,"truncated":false}}""")),
            c => c.RunAsync(Catalog.EventlogQuery, JsonSerializer.SerializeToElement(new { log = "System" }), default)));
        Assert.Equal("execution_failed", e.Code);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("{\"status\":\"succeeded\"}")]
    public async Task The_client_refuses_a_malformed_answer(string answer)
    {
        var e = await Assert.ThrowsAsync<OperationFailedException>(() => WithServer(
            _ => Task.FromResult<byte[]?>(Bytes(answer)),
            c => c.RunAsync(Catalog.EventlogQuery, JsonSerializer.SerializeToElement(new { log = "System" }), default)));
        Assert.Contains(e.Code, new[] { "unavailable", "execution_failed" });
    }

    [Fact]
    public async Task The_client_refuses_output_that_breaks_the_operation_contract()
    {
        var e = await Assert.ThrowsAsync<OperationFailedException>(() => WithServer(
            r =>
            {
                string id = JsonDocument.Parse(r).RootElement.GetProperty("requestId").GetString()!;
                return Task.FromResult<byte[]?>(Bytes($$$"""{"requestId":"{{{id}}}","status":"succeeded","output":{"log":"Security","entries":[],"nextBeforeRecordId":null,"truncated":false}}"""));
            },
            c => c.RunAsync(Catalog.EventlogQuery, JsonSerializer.SerializeToElement(new { log = "System" }), default)));
        Assert.Equal("execution_failed", e.Code);
    }

    [Fact]
    public async Task Framing_refuses_oversize_negative_and_short_frames()
    {
        foreach (byte[] frame in new[]
        {
            BitConverter.GetBytes(BrokerFraming.MaxRequestBytes + 1),
            BitConverter.GetBytes(-5),
            BitConverter.GetBytes(0),
            BitConverter.GetBytes(10).Concat(new byte[] { 1, 2, 3 }).ToArray(),
            new byte[] { 1, 0 },
        })
            Assert.Null(await BrokerFraming.ReadAsync(new MemoryStream(frame), BrokerFraming.MaxRequestBytes, default));
    }

    [Fact]
    public async Task A_broker_that_hangs_up_before_reading_is_reported_as_unavailable()
    {
        string name = "cabinet-test-" + Guid.NewGuid().ToString("N");
        var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        Task hangUp = Task.Run(async () => { await server.WaitForConnectionAsync(); server.Dispose(); });
        var client = new BrokerClient(async t =>
        {
            var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            await pipe.ConnectAsync(5000, t);
            await hangUp;
            return pipe;
        });
        Assert.False(await client.PingAsync(default));
    }

    [Fact]
    public async Task An_unreachable_broker_is_reported_as_unavailable()
    {
        var client = new BrokerClient(_ => throw new TimeoutException());
        Assert.False(await client.PingAsync(default));
        var e = await Assert.ThrowsAsync<OperationFailedException>(() => client.RunAsync(Catalog.DiskSmart, JsonSerializer.SerializeToElement(new { }), default));
        Assert.Equal("unavailable", e.Code);
    }
}

public class BrokerOwnChecksTests
{
    private static byte[] Restart(int n) => JsonSerializer.SerializeToUtf8Bytes(new
    {
        requestId = Guid.NewGuid(), kind = "operation", operation = "service.control", commandId = Guid.NewGuid(), @params = new { name = "BioScanSvc", action = "restart" },
    });

    private static BrokerResponse Response(byte[]? reply) => JsonSerializer.Deserialize<BrokerResponse>(reply!, ContractJson.Options)!;

    [Fact]
    public async Task The_broker_refuses_writes_in_read_only_mode_whatever_the_network_process_says()
    {
        var platform = new Cabinet.Agent.Core.Tests.FakeServices();
        var handler = new BrokerRequestHandler(new Cabinet.Agent.Core.Services.ServiceControl(platform, _ => { }).Register(new OperationRegistry()), readOnly: () => true);
        var r = Response(await handler.HandleAsync(Restart(1), default));
        Assert.Equal(BrokerStatus.Failed, r.Status);
        Assert.Equal("read_only_mode", r.Error!.Code);
        Assert.Empty(platform.Calls);
        // A configuration it cannot read allows no changes either.
        var unreadable = new BrokerRequestHandler(new Cabinet.Agent.Core.Services.ServiceControl(platform, _ => { }).Register(new OperationRegistry()), readOnly: () => throw new IOException("locked"));
        Assert.Equal("read_only_mode", Response(await unreadable.HandleAsync(Restart(2), default)).Error!.Code);
        Assert.Empty(platform.Calls);
    }

    [Fact]
    public async Task The_broker_keeps_its_own_write_limit()
    {
        var platform = new Cabinet.Agent.Core.Tests.FakeServices();
        using var dir = new TempDir();
        var clock = new ManualClock(Fixtures.Start);
        var handler = new BrokerRequestHandler(new Cabinet.Agent.Core.Services.ServiceControl(platform, _ => { }).Register(new OperationRegistry()), readOnly: () => false,
            writeLimit: new RateLimiter(Path.Combine(dir.Path, "w.log"), clock), clock: clock);
        for (int i = 0; i < 20; i++) Assert.Equal(BrokerStatus.Succeeded, Response(await handler.HandleAsync(Restart(i), default)).Status);
        var r = Response(await handler.HandleAsync(Restart(21), default));
        Assert.Equal("rate_limited", r.Error!.Code);
        // The limit is kept on disk: a restarted broker still counts the hour's writes.
        var again = new BrokerRequestHandler(new Cabinet.Agent.Core.Services.ServiceControl(platform, _ => { }).Register(new OperationRegistry()), readOnly: () => false,
            writeLimit: new RateLimiter(Path.Combine(dir.Path, "w.log"), clock), clock: clock);
        Assert.Equal("rate_limited", Response(await again.HandleAsync(Restart(22), default)).Error!.Code);
    }
}

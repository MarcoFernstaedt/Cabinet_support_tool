using static Cabinet.Agent.Core.Tests.Fixtures;

namespace Cabinet.Agent.Core.Tests;

/// <summary>The six checks, every rejection code the agent can produce in milestone 1, and their order.</summary>
public sealed class CommandValidatorTests
{
    private readonly ManualClock _clock = new(Start);

    private CommandValidator Validator(AgentConfig? config = null, ReplayStore? replay = null, RateLimiter? limits = null) =>
        new(config ?? Config(), replay ?? new ReplayStore(null, _clock), limits ?? new RateLimiter(null, _clock), _clock);

    private static string? Code(ValidationOutcome outcome) => outcome switch
    {
        ValidationOutcome.Rejected r => r.Rejection.Code,
        ValidationOutcome.Accepted => null,
        ValidationOutcome.Unaddressable => "unaddressable",
        _ => throw new InvalidOperationException(),
    };

    private string? Run(JsonNode command, CommandValidator? validator = null) => Code((validator ?? Validator()).Validate(Bytes(command)));

    [Fact]
    public void A_well_formed_read_command_is_accepted()
    {
        var outcome = Validator().Validate(Bytes(Command("eventlog.query", new JsonObject { ["log"] = "System", ["levels"] = new JsonArray("error") })));
        var accepted = Assert.IsType<ValidationOutcome.Accepted>(outcome);
        Assert.Equal("eventlog.query", accepted.Command.Entry.Name);
    }

    // ---- Step 1: unknown_operation ---------------------------------------------
    [Theory]
    [InlineData("shell.run")]
    [InlineData("System.Info")]
    [InlineData("system.info ")]
    [InlineData("system\u2024info")]
    [InlineData("")]
    [InlineData("powershell")]
    public void Step1_operations_outside_the_catalog_are_unknown(string operation) =>
        Assert.Equal("unknown_operation", Run(Command(operation)));

    [Fact]
    public void Step1_a_missing_or_non_string_operation_is_unknown()
    {
        var command = Command(); command.Remove("operation");
        Assert.Equal("unknown_operation", Run(command));
        command["operation"] = 7;
        Assert.Equal("unknown_operation", Run(command));
    }

    // ---- Step 2: wrong_cabinet ---------------------------------------------------
    [Fact]
    public void Step2_a_command_for_another_cabinet_is_refused() =>
        Assert.Equal("wrong_cabinet", Run(Command(cabinet: Guid.NewGuid())));

    // ---- Step 3: expired ---------------------------------------------------------
    [Fact]
    public void Step3_a_command_past_its_expiry_and_the_skew_tolerance_is_expired()
    {
        _clock.Now = Start.AddSeconds(60) + CommandValidator.ClockSkew + TimeSpan.FromSeconds(1);
        Assert.Equal("expired", Run(Command(lifetimeSeconds: 60)));
    }

    [Fact]
    public void Step3_a_command_just_inside_the_skew_tolerance_is_accepted()
    {
        _clock.Now = Start.AddSeconds(60) + CommandValidator.ClockSkew;
        Assert.Null(Run(Command(lifetimeSeconds: 60)));
    }

    [Fact]
    public void Step3_a_read_may_live_at_most_five_minutes_and_a_write_two()
    {
        Assert.Null(Run(Command("system.info", lifetimeSeconds: 300)));
        Assert.Equal("expired", Run(Command("system.info", lifetimeSeconds: 301)));
        Assert.Equal("expired", Run(Command("network.setDns", new JsonObject { ["interfaceIndex"] = 3, ["mode"] = "automatic" }, lifetimeSeconds: 121)));
    }

    [Fact]
    public void Step3_a_command_that_expires_before_it_was_issued_is_expired()
    {
        var command = Command();
        command["expiresAt"] = Time(Start.AddSeconds(-1));
        Assert.Equal("expired", Run(command));
        command["expiresAt"] = Time(Start);
        Assert.Equal("expired", Run(command));
    }

    [Fact]
    public void Step3_a_command_issued_in_the_future_beyond_the_skew_is_expired()
    {
        Assert.Equal("expired", Run(Command(issued: Start + CommandValidator.ClockSkew + TimeSpan.FromSeconds(1))));
        Assert.Null(Run(Command(issued: Start + CommandValidator.ClockSkew)));
    }

    // ---- Step 4: replayed --------------------------------------------------------
    [Fact]
    public void Step4_the_same_command_id_is_refused_the_second_time()
    {
        var validator = Validator();
        var command = Command();
        Assert.Null(Run(command, validator));
        Assert.Equal("replayed", Run(command, validator));
    }

    [Fact]
    public void Step4_a_replay_is_refused_even_when_the_first_copy_failed_a_later_check()
    {
        var validator = Validator();
        var command = Command("files.list", new JsonObject { ["path"] = "D:\\" });
        Assert.Equal("invalid_params", Run(command, validator));
        Assert.Equal("replayed", Run(command, validator));
    }

    [Fact]
    public void Step4_replay_protection_survives_an_agent_restart()
    {
        using var dir = new TempDir();
        var command = Command();
        Assert.Null(Run(command, Validator(replay: new ReplayStore(dir.File("replay"), _clock))));
        Assert.Equal("replayed", Run(command, Validator(replay: new ReplayStore(dir.File("replay"), _clock))));
    }

    // ---- Step 5: invalid_params --------------------------------------------------
    public static IEnumerable<object[]> HostileParams() => new[]
    {
        new object[] { "eventlog.query", """{"log":"Security"}""" },
        new object[] { "eventlog.query", """{"log":"Microsoft-Windows-PowerShell/Operational"}""" },
        new object[] { "eventlog.query", """{"log":"System","pageSize":100000}""" },
        new object[] { "eventlog.query", """{"log":"System","source":"x\u0000' or '1'='1"}""" },
        new object[] { "eventlog.get", """{"log":"System","recordId":-1}""" },
        new object[] { "files.list", """{"path":"C:\\Windows\\..\\Users"}""" },
        new object[] { "files.list", """{"path":"\\\\server\\share"}""" },
        new object[] { "files.list", """{"path":"C:\\file.txt:secret"}""" },
        new object[] { "files.list", """{"path":"C:\\*"}""" },
        new object[] { "devices.list", """{"problemsOnly":"yes"}""" },
        new object[] { "system.info", """{"command":"whoami"}""" },
        new object[] { "network.test", """{"target":"8.8.8.8","method":"ping"}""" },
        new object[] { "network.test", """{"target":"gateway","method":"tcp"}""" },
        new object[] { "network.test", """{"target":"gateway","method":"ping","host":"10.0.0.1"}""" },
        new object[] { "network.test", """{"target":"gateway","method":"dns","count":3}""" },
        new object[] { "network.test", """{"target":"gateway","method":"ping","count":500}""" },
        new object[] { "network.test", """{"target":"sync_cabinet","method":"tcp","port":1433,"count":500}""" },
        new object[] { "network.test", """{"target":"sync_cabinet","method":"tcp","port":1433,"count":11}""" },
        new object[] { "network.test", """{"target":"gateway","method":"dns","count":2}""" },
        new object[] { "network.trace", """{"target":"8.8.8.8"}""" },
        new object[] { "network.trace", """{"target":"gateway","maxHops":999}""" },
        new object[] { "network.trace", """{"target":"gateway","host":"10.0.0.1"}""" },
        new object[] { "network.trace", """{"target":"dns_server"}""" },
        new object[] { "network.trace", """{"target":"gateway","syncAddress":"10.0.0.5"}""" },
        new object[] { "database.connectivity", """{"port":1433,"host":"db.example.org"}""" },
        new object[] { "database.connectivity", """{"port":1433,"user":"sa","password":"hunter2"}""" },
        new object[] { "database.connectivity", """{"port":1433,"database":"cabinet_app"}""" },
        new object[] { "database.connectivity", """{"port":1433,"query":"SELECT 1"}""" },
        new object[] { "database.connectivity", """{"port":0}""" },
        new object[] { "database.connectivity", """{}""" },
        new object[] { "database.connectivity", """{"port":1433,"syncAddress":"sql.example.org"}""" },
    };

    [Theory]
    [MemberData(nameof(HostileParams))]
    public void Step5_parameters_that_fail_the_schema_are_refused(string operation, string parameters) =>
        Assert.Equal("invalid_params", Run(Command(operation, (JsonObject)JsonNode.Parse(parameters)!)));

    [Fact]
    public void Step5_params_that_are_not_an_object_are_refused()
    {
        var command = Command(); command["params"] = new JsonArray();
        Assert.Equal("invalid_params", Run(command));
    }

    [Fact]
    public void Step5_tcp_tests_only_go_to_ports_in_the_local_allow_list()
    {
        var p = new JsonObject { ["target"] = "sync_cabinet", ["method"] = "tcp", ["port"] = 445 };
        Assert.Equal("invalid_params", Run(Command("network.test", p)));
        Assert.Null(Run(Command("network.test", (JsonObject)p.DeepClone()), Validator(Config(ports: new[] { 445 }))));
    }

    [Fact]
    public void Step5_the_database_check_only_goes_to_allowed_ports()
    {
        var p = new JsonObject { ["port"] = 1433 };
        Assert.Equal("invalid_params", Run(Command("database.connectivity", p)));
        Assert.Null(Run(Command("database.connectivity", (JsonObject)p.DeepClone()), Validator(Config(ports: new[] { 1433 }))));
        // The site's sync ports, filled in by the server, allow it too, and only for those ports.
        Assert.Null(Run(Command("database.connectivity", new JsonObject { ["port"] = 1433, ["syncPorts"] = new JsonArray(1433) })));
        Assert.Equal("invalid_params", Run(Command("database.connectivity", new JsonObject { ["port"] = 1434, ["syncPorts"] = new JsonArray(1433) })));
    }

    [Theory]
    [InlineData("extra")]
    [InlineData("issuedAtNonUtc")]
    [InlineData("missingIssuedBy")]
    [InlineData("bracedCabinet")]
    public void A_malformed_envelope_is_refused_as_invalid_params(string fault)
    {
        var command = Command();
        switch (fault)
        {
            case "extra": command["runAs"] = "SYSTEM"; break;
            case "issuedAtNonUtc": command["issuedAt"] = "2026-10-06T14:00:00+02:00"; break;
            case "missingIssuedBy": command.Remove("issuedBy"); break;
            case "bracedCabinet": command["cabinetId"] = "{" + Fixtures.Cabinet + "}"; break;
        }
        Assert.Equal("invalid_params", Run(command));
    }

    // ---- Step 6: read_only_mode and rate_limited ---------------------------------
    [Fact]
    public void Step6_writes_are_refused_in_read_only_mode_and_reads_are_not()
    {
        var validator = Validator(Config(readOnly: true));
        Assert.Equal("read_only_mode", Run(Command("network.setDns", new JsonObject { ["interfaceIndex"] = 3, ["mode"] = "automatic" }), validator));
        Assert.Null(Run(Command("system.info"), validator));
    }

    [Fact]
    public void Step6_the_61st_read_in_a_minute_is_rate_limited_and_the_window_slides()
    {
        var validator = Validator();
        for (int i = 0; i < 60; i++) Assert.Null(Run(Command(), validator));
        Assert.Equal("rate_limited", Run(Command(), validator));
        _clock.Advance(TimeSpan.FromSeconds(61));
        Assert.Null(Run(Command(issued: _clock.Now), validator));
    }

    [Fact]
    public void Step6_the_13th_path_trace_in_a_minute_is_rate_limited_and_has_its_own_budget()
    {
        var validator = Validator();
        for (int i = 0; i < 12; i++) Assert.Null(Run(Command("network.trace", new JsonObject { ["target"] = "gateway" }), validator));
        Assert.Equal("rate_limited", Run(Command("network.trace", new JsonObject { ["target"] = "gateway" }), validator));
        Assert.Null(Run(Command("network.test", new JsonObject { ["target"] = "gateway", ["method"] = "ping" }), validator));
    }

    [Fact]
    public void Step6_the_11th_network_test_in_a_minute_is_rate_limited()
    {
        var validator = Validator();
        JsonObject Ping() => new() { ["target"] = "gateway", ["method"] = "ping" };
        for (int i = 0; i < 10; i++) Assert.Null(Run(Command("network.test", Ping()), validator));
        Assert.Equal("rate_limited", Run(Command("network.test", Ping()), validator));
        Assert.Null(Run(Command("system.info"), validator)); // reads have their own budget
    }

    [Fact]
    public void Step6_the_21st_write_in_an_hour_is_rate_limited_even_after_a_restart()
    {
        using var dir = new TempDir();
        JsonObject Dns() => new() { ["interfaceIndex"] = 3, ["mode"] = "automatic" };
        var first = Validator(limits: new RateLimiter(dir.File("writes"), _clock));
        for (int i = 0; i < 20; i++) Assert.Null(Run(Command("network.setDns", Dns()), first));
        var restarted = Validator(limits: new RateLimiter(dir.File("writes"), _clock));
        Assert.Equal("rate_limited", Run(Command("network.setDns", Dns()), restarted));
        _clock.Advance(TimeSpan.FromHours(1));
        Assert.Null(Run(Command("network.setDns", Dns(), issued: _clock.Now), Validator(limits: new RateLimiter(dir.File("writes"), _clock))));
    }

    // ---- Order -------------------------------------------------------------------
    [Fact]
    public void The_checks_run_in_the_specified_order()
    {
        // Each command fails two checks; the earlier one must be reported.
        Assert.Equal("unknown_operation", Run(Command("shell.run", cabinet: Guid.NewGuid())));
        _clock.Now = Start.AddHours(1);
        Assert.Equal("wrong_cabinet", Run(Command(cabinet: Guid.NewGuid())));
        _clock.Now = Start;

        var validator = Validator(Config(readOnly: true));
        var seen = Command();
        Assert.Null(Run(seen, validator));
        _clock.Now = Start.AddHours(1);
        Assert.Equal("expired", Run(seen, validator));          // expired beats replayed
        _clock.Now = Start;
        var bad = Command("files.list", new JsonObject { ["path"] = "D:\\" }, id: Guid.Parse(seen["commandId"]!.GetValue<string>()));
        Assert.Equal("replayed", Run(bad, validator));          // replayed beats invalid_params
        Assert.Equal("invalid_params", Run(Command("network.setDns", new JsonObject { ["mode"] = "manual" }), validator)); // beats read_only_mode
    }

    // ---- Unreadable input --------------------------------------------------------
    [Theory]
    [InlineData("")]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("\"command\"")]
    [InlineData("{")]
    [InlineData("{\"commandId\":\"not-a-uuid\",\"operation\":\"system.info\"}")]
    [InlineData("{\"operation\":\"system.info\"} // comment")]
    public void Input_without_a_readable_command_id_is_dropped(string text) =>
        Assert.Equal("unaddressable", Code(Validator().Validate(Bytes(text))));

    [Fact]
    public void Duplicate_property_names_are_refused_anywhere_in_the_command()
    {
        string json = Command().ToJsonString();
        string twoOps = json.Replace("\"operation\":\"system.info\"", "\"operation\":\"system.info\",\"operation\":\"files.list\"");
        Assert.Equal("unaddressable", Code(Validator().Validate(Bytes(twoOps))));
        string nested = Command("eventlog.query", new JsonObject { ["log"] = "System" }).ToJsonString()
            .Replace("\"log\":\"System\"", "\"log\":\"System\",\"log\":\"Security\"");
        Assert.Equal("unaddressable", Code(Validator().Validate(Bytes(nested))));
    }

    [Fact]
    public void Oversized_and_deeply_nested_commands_are_dropped_quickly()
    {
        var started = DateTime.UtcNow;
        var big = Command("eventlog.query", new JsonObject { ["log"] = "System", ["source"] = new string('x', CommandValidator.MaxCommandBytes) });
        Assert.Equal("unaddressable", Code(Validator().Validate(Bytes(big))));
        string deep = new string('[', 5000) + new string(']', 5000);
        var command = Command().ToJsonString().Replace("\"params\":{}", $"\"params\":{{\"a\":{deep}}}");
        Assert.Equal("unaddressable", Code(Validator().Validate(Bytes(command))));
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(2));
    }

    [Fact]
    public void A_long_but_allowed_command_is_refused_by_the_schema_not_by_a_crash() =>
        Assert.Equal("invalid_params", Run(Command("eventlog.query", new JsonObject { ["log"] = "System", ["source"] = new string('x', 100_000) })));

    [Fact]
    public void Rejection_messages_never_echo_the_submitted_values()
    {
        const string marker = "ATTACKER-MARKER-7f3a";
        var commands = new[]
        {
            Command("shell." + marker),
            Command("files.list", new JsonObject { ["path"] = "D:\\" + marker }),
            Command(cabinet: Guid.NewGuid()),
        };
        foreach (var c in commands)
        {
            var outcome = Assert.IsType<ValidationOutcome.Rejected>(Validator().Validate(Bytes(c)));
            Assert.DoesNotContain(marker, outcome.Rejection.Message);
        }
    }

    [Fact]
    public void The_package_verification_codes_are_known_but_produced_only_by_package_install()
    {
        // hash_mismatch, signature_invalid, publisher_not_trusted and verification_failed come from
        // package verification on the cabinet (milestone 5). They are valid result codes now.
        foreach (string code in new[] { "hash_mismatch", "signature_invalid", "publisher_not_trusted", "verification_failed" })
            Assert.Contains(code, Catalog.RejectionCodes);
    }
}

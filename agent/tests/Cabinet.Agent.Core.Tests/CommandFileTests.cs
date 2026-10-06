using static Cabinet.Agent.Core.Tests.Fixtures;

namespace Cabinet.Agent.Core.Tests;

public sealed class CommandFileTests
{
    private readonly ManualClock _clock = new(Start);

    private CommandProcessor Processor() => new(
        new CommandValidator(Config(), new ReplayStore(null, _clock), new RateLimiter(null, _clock), _clock),
        new OperationRegistry().Register<EmptyParams, SystemInfoOutput>(Catalog.SystemInfo, (_, _) => Task.FromResult(new SystemInfoOutput
        {
            Hostname = "CAB-01", OsVersion = "Windows", OsBuild = "1", UptimeSeconds = 1, AgentVersion = "0.1.0", ReadOnlyMode = false, CabinetRole = null, SerialNumber = null,
        })),
        _clock);

    [Fact]
    public async Task Every_command_in_the_file_gets_the_full_checks()
    {
        var file = new JsonArray(Command(), Command(cabinet: Guid.NewGuid()), Command("shell.run"), JsonValue.Create("not a command"));
        var entries = await CommandFile.RunAsync(Bytes(file), Processor(), default);
        Assert.Equal(ResultStatus.Succeeded, entries[0].Result!.Status);
        Assert.Equal("wrong_cabinet", entries[1].Result!.Error!.Code);
        Assert.Equal("unknown_operation", entries[2].Result!.Error!.Code);
        Assert.NotNull(entries[3].Dropped);

        var written = JsonNode.Parse(CommandFile.Write(entries))!.AsArray();
        Assert.Equal(4, written.Count);
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Envelope("result"), JsonSerializer.SerializeToElement(written[0]!["result"])));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("[")]
    [InlineData("[{\"a\":1,\"a\":2}]")]
    public async Task A_malformed_file_is_refused_whole(string text) =>
        await Assert.ThrowsAsync<CommandFileException>(() => CommandFile.RunAsync(Bytes(text), Processor(), default));

    [Fact]
    public async Task A_file_with_too_many_commands_is_refused() =>
        await Assert.ThrowsAsync<CommandFileException>(() => CommandFile.RunAsync(
            Bytes(new JsonArray(Enumerable.Range(0, CommandFile.MaxCommands + 1).Select(_ => (JsonNode)Command()).ToArray())), Processor(), default));

    [Fact]
    public async Task Made_commands_pass_validation_for_every_read_operation()
    {
        var commands = CommandFile.EveryRead(Config(), Start);
        Assert.Equal(Catalog.All.Count(e => e.Kind == OperationKind.Read), commands.Count);
        var validator = new CommandValidator(Config(), new ReplayStore(null, _clock), new RateLimiter(null, _clock), _clock);
        foreach (Command c in commands)
            Assert.IsType<ValidationOutcome.Accepted>(validator.Validate(JsonSerializer.SerializeToUtf8Bytes(c, ContractJson.Options)));
        await Task.CompletedTask;
    }

    [Fact]
    public void Make_refuses_unknown_operations_and_bad_parameters()
    {
        Assert.Throws<CommandFileException>(() => CommandFile.Make(Config(), "shell.run", JsonSerializer.SerializeToElement(new { }), Start));
        Assert.Throws<CommandFileException>(() => CommandFile.Make(Config(), Catalog.EventlogQuery, JsonSerializer.SerializeToElement(new { log = "Security" }), Start));
    }
}

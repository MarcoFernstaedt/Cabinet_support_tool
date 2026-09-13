using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Tests.Identity;

public sealed class FileAgentStateStoreTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "agent-state-test-" + Guid.NewGuid());
    private FileAgentStateStore Store() => new(Options.Create(new AgentOptions { StateDirectory = _directory }), NullLogger<FileAgentStateStore>.Instance);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void FailedWriteOrRenameDoesNotAdvanceCache(bool failRename)
    {
        var store = Store();
        store.Update(s => s with { MachineId = "original" });
        var path = Path.Combine(_directory, "agent-state.json");
        if (failRename) File.Delete(path);
        Directory.CreateDirectory(failRename ? path : path + ".tmp");
        var error = Record.Exception(() => store.Update(s => s with { MachineId = "unsafe" }));
        Assert.True(error is IOException or UnauthorizedAccessException);
        Assert.Equal("original", store.Load().MachineId);
    }

    [Theory]
    [InlineData("{broken")]
    [InlineData("null")]
    public void UnreadableStateStaysFailClosedAcrossRestarts(string json)
    {
        Directory.CreateDirectory(_directory);
        File.WriteAllText(Path.Combine(_directory, "agent-state.json"), json);
        Assert.ThrowsAny<Exception>(() => Store().Load());
        Assert.ThrowsAny<Exception>(() => Store().Load());
    }

    public void Dispose() => Directory.Delete(_directory, true);
}

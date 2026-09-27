using CabinetPlatform.Agent.Connectivity;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Tests;

public sealed class ConnectivitySpoolTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Reopening_a_full_outbox_enforces_both_compiled_file_and_byte_caps(bool largeFrames)
    {
        var directory = Path.Combine(Path.GetTempPath(), $"connectivity-cap-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var now = DateTimeOffset.UtcNow;
            int count = largeFrames ? 3000 : ConnectivitySpool.MaximumFiles + 1;
            for (var i = 0; i < count; i++)
            {
                var summary = new ConnectivitySummary { Id = Guid.NewGuid(), FirstObservedUtc = now.AddMinutes(-2), LastObservedUtc = now };
                var json = System.Text.Json.JsonSerializer.Serialize(summary, CabinetPlatform.Agent.Transport.AgentJson.SerializerOptions);
                if (largeFrames) json = json.PadRight(4096);
                File.WriteAllText(Path.Combine(directory, $"{summary.Id:N}.json"), json);
            }
            var spool = new ConnectivitySpool(directory);
            Assert.Equal(16, spool.Peek(now).Count);
            var files = new DirectoryInfo(directory).GetFiles("*.json");
            Assert.True(files.Length <= ConnectivitySpool.MaximumFiles);
            Assert.True(files.Sum(f => f.Length) <= ConnectivitySpool.MaximumBytes);
            Assert.True(files.Length < count);
            Assert.Empty(spool.Peek(now.AddDays(15)));
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public void Durable_interval_survives_reopen_until_acknowledged_and_expired_samples_are_pruned()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"connectivity-{Guid.NewGuid():N}");
        try
        {
            var now = DateTimeOffset.UtcNow;
            var summary = new ConnectivitySummary
            {
                Id = Guid.NewGuid(), ConfigurationId = Guid.NewGuid(), SourceCabinetId = Guid.NewGuid(), TargetCabinetId = Guid.NewGuid(),
                FirstObservedUtc = now.AddMinutes(-2), LastObservedUtc = now, FailureCount = 3,
                LeadingFailures = 3, TrailingFailures = 3, MaximumFailureRun = 3, LastFailureUtc = now
            };
            var spool = new ConnectivitySpool(directory);
            Assert.True(spool.Enqueue(summary, now));
            var reopened = new ConnectivitySpool(directory);
            Assert.Equal(summary, Assert.Single(reopened.Peek(now)));
            reopened.Acknowledge([summary.Id]);
            Assert.Empty(spool.Peek(now));
            Assert.False(spool.Enqueue(summary with { FirstObservedUtc = now.AddDays(-15), LastObservedUtc = now.AddDays(-15) }, now));
            Assert.Empty(spool.Peek(now));
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }
}

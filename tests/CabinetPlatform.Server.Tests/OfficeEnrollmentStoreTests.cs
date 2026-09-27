using System.Security.Cryptography;
using System.Text;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Tests;

public sealed class OfficeEnrollmentStoreTests
{
    [Fact]
    public async Task Concurrent_redemption_has_one_winner_and_survives_reopen()
    {
        using var fixture = new Fixture();
        var winners = new List<int>();
        using (var store = fixture.Open())
        {
            var outcomes = await Task.WhenAll(Enumerable.Range(0, 20).Select(i => Task.Run(() =>
                (Index: i, Accepted: store.Redeem(fixture.Token, "device-" + i, fixture.Key)))));
            winners = outcomes.Where(x => x.Accepted).Select(x => x.Index).ToList();
            Assert.Single(winners);
        }
        using var reopened = fixture.Open();
        Assert.True(reopened.Redeem(fixture.Token, "device-" + winners[0], fixture.Key));
        Assert.False(reopened.Redeem(fixture.Token, "different-device", fixture.Key));
    }

    [Fact]
    public void Expired_unspent_token_denied_but_lost_response_retry_is_bound_until_device_expiry()
    {
        using var fixture = new Fixture();
        using (var store = fixture.Open())
        {
            Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
            fixture.Clock.Now = fixture.Issued.AddHours(1);
            Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
            Assert.True(fixture.Authenticate(store, "device", fixture.Key));
            fixture.Clock.Now = fixture.Issued.AddDays(1);
            Assert.False(fixture.Authenticate(store, "device", fixture.Key));
            Assert.False(store.Redeem(fixture.Token, "device", fixture.Key));
        }
        File.WriteAllText(fixture.File, "[]"); // A distinct unspent fixture, not recovery guidance.
        fixture.Clock.Now = fixture.Issued.AddMinutes(30);
        using var unspent = fixture.Open();
        Assert.False(unspent.Redeem(fixture.Token, "device", fixture.Key));
    }

    [Fact]
    public void Removed_token_revokes_issued_device_on_restart()
    {
        using var fixture = new Fixture();
        using (var store = fixture.Open()) Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        fixture.Options.Tokens.Clear();
        using var revoked = fixture.Open();
        Assert.False(fixture.Authenticate(revoked, "device", fixture.Key));
        Assert.False(revoked.Redeem(fixture.Token, "device", fixture.Key));
    }

    [Fact]
    public void Journal_is_exclusively_owned_and_corruption_is_never_reinitialized()
    {
        using var fixture = new Fixture();
        using (var first = fixture.Open())
            Assert.Throws<IOException>(() => fixture.Open());
        File.WriteAllText(fixture.File, "null");
        Assert.Throws<InvalidOperationException>(() => fixture.Open());
        Assert.Equal("null", File.ReadAllText(fixture.File));
        File.Delete(fixture.File);
        Assert.Throws<FileNotFoundException>(() => fixture.Open());
        Assert.False(File.Exists(fixture.File));
    }

    [Fact]
    public void Failed_persistence_does_not_consume_token_or_authenticate_device()
    {
        using var fixture = new Fixture();
        using var store = fixture.Open();
        File.Delete(fixture.File);
        Directory.CreateDirectory(fixture.File);
        Assert.Throws<IOException>(() => store.Redeem(fixture.Token, "device-a", fixture.Key));
        Assert.False(fixture.Authenticate(store, "device-a", fixture.Key));
        Directory.Delete(fixture.File);
        File.WriteAllText(fixture.File, "[]");
        Assert.True(store.Redeem(fixture.Token, "device-b", fixture.Key));
    }

    [Theory]
    [InlineData("", "device", "key")]
    [InlineData("invalid", "device", "key")]
    [InlineData("valid", " device ", "valid")]
    [InlineData("valid", "device\r\nheader", "valid")]
    public void Malformed_credentials_fail_closed(string token, string machine, string key)
    {
        using var fixture = new Fixture();
        using var store = fixture.Open();
        Assert.False(store.Redeem(token == "valid" ? fixture.Token : token, machine, key == "valid" ? fixture.Key : key));
    }

    [Fact]
    public void Another_token_cannot_rebind_existing_machine_identity()
    {
        using var fixture = new Fixture();
        var another = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        fixture.Options.Tokens.Add(fixture.Options.Tokens[0] with { TokenHash = Hash(another) });
        using var store = fixture.Open();
        Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        Assert.False(store.Redeem(another, "device", fixture.Key));
    }

    [Fact]
    public void Authorized_same_key_recovery_after_expiry_is_bounded_durable_and_idempotent()
    {
        using var fixture = new Fixture();
        var requestId = Guid.NewGuid();
        using (var store = fixture.Open()) Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        fixture.Clock.Now = fixture.Issued.AddDays(2);
        using (var store = fixture.Open())
        {
            Assert.False(fixture.Authenticate(store, "device", fixture.Key));
            var expiry = store.Renew("device", requestId, "supervisor-id", "lab repeat");
            Assert.Equal(fixture.Clock.Now.AddDays(1), expiry);
            Assert.True(fixture.Authenticate(store, "device", fixture.Key));
            Assert.False(fixture.Authenticate(store, "device", Convert.ToHexString(RandomNumberGenerator.GetBytes(32))));
        }
        fixture.Clock.Now = fixture.Clock.Now.AddHours(1);
        using (var store = fixture.Open())
        {
            Assert.Equal(fixture.Issued.AddDays(3), store.Renew("device", requestId, "supervisor-id", "lab repeat"));
            Assert.Null(store.Renew("device", requestId, "other-supervisor", "lab repeat"));
            Assert.Null(store.Renew("missing", Guid.NewGuid(), "supervisor-id", "lab repeat"));
            fixture.Clock.Now = fixture.Issued.AddDays(3);
            Assert.False(fixture.Authenticate(store, "device", fixture.Key));
        }
    }

    [Fact]
    public void Removed_token_cannot_be_renewed_or_resurrected_by_readding_it()
    {
        using var fixture = new Fixture();
        using (var store = fixture.Open()) Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        var token = fixture.Options.Tokens[0];
        fixture.Options.Tokens.Clear();
        using (var store = fixture.Open())
            Assert.Null(store.Renew("device", Guid.NewGuid(), "supervisor-id", "lab repeat"));
        fixture.Options.Tokens.Add(token);
        using var reopened = fixture.Open();
        Assert.False(fixture.Authenticate(reopened, "device", fixture.Key));
        Assert.Null(reopened.Renew("device", Guid.NewGuid(), "supervisor-id", "lab repeat"));
    }

    [Fact]
    public async Task Concurrent_renewal_retries_record_one_grant_and_persistence_failure_does_not_activate()
    {
        using var fixture = new Fixture();
        using var store = fixture.Open();
        Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        fixture.Clock.Now = fixture.Issued.AddDays(2);
        var id = Guid.NewGuid();
        var expiries = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Task.Run(() =>
            store.Renew("device", id, "supervisor-id", "lab repeat"))));
        Assert.All(expiries, expiry => Assert.Equal(fixture.Clock.Now.AddDays(1), expiry));
        Assert.Single(System.Text.Json.JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(File.ReadAllText(fixture.File))![0].Renewals);
        using var failedFixture = new Fixture();
        using var failedStore = failedFixture.Open();
        Assert.True(failedStore.Redeem(failedFixture.Token, "device", failedFixture.Key));
        failedFixture.Clock.Now = failedFixture.Issued.AddDays(2);
        File.Delete(failedFixture.File);
        Directory.CreateDirectory(failedFixture.File);
        Assert.Throws<IOException>(() => failedStore.Renew("device", Guid.NewGuid(), "supervisor-id", "lab repeat"));
        Assert.False(failedFixture.Authenticate(failedStore, "device", failedFixture.Key));
        Directory.Delete(failedFixture.File);
        File.WriteAllText(failedFixture.File, "[]");
    }

    [Fact]
    public void Preexisting_tombstone_is_shredded_without_losing_renewal_history()
    {
        using var fixture = new Fixture();
        var request = Guid.NewGuid();
        using (var store = fixture.Open())
        {
            Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
            fixture.Clock.Now = fixture.Issued.AddDays(2);
            Assert.NotNull(store.Renew("device", request, "supervisor-id", "lab repeat"));
        }
        var old = System.Text.Json.JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(File.ReadAllText(fixture.File))!;
        File.WriteAllText(fixture.File, System.Text.Json.JsonSerializer.Serialize(old.Select(g => g with { Revoked = true, KeyDestroyed = false })));
        using (var store = fixture.Open()) Assert.False(fixture.Authenticate(store, "device", fixture.Key));
        var upgraded = System.Text.Json.JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(File.ReadAllText(fixture.File))!;
        Assert.True(upgraded[0].Revoked);
        Assert.True(upgraded[0].KeyDestroyed);
        Assert.NotEqual(old[0].KeyHash, upgraded[0].KeyHash);
        Assert.Equal(old[0].TokenHash, upgraded[0].TokenHash);
        Assert.Equal(old[0].MachineId, upgraded[0].MachineId);
        Assert.Equal(request, Assert.Single(upgraded[0].Renewals).RequestId);
    }

    [Fact]
    public void Clock_rollback_cannot_extend_or_replace_a_recorded_renewal()
    {
        using var fixture = new Fixture();
        using var store = fixture.Open();
        Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        fixture.Clock.Now = fixture.Issued.AddDays(2);
        Assert.NotNull(store.Renew("device", Guid.NewGuid(), "supervisor-id", "lab repeat"));
        fixture.Clock.Now = fixture.Issued.AddDays(1);
        Assert.Null(store.Renew("device", Guid.NewGuid(), "supervisor-id", "lab repeat"));
    }

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now { get; set; }
        public override DateTimeOffset GetUtcNow() => Now;
    }
    private sealed class Fixture : IDisposable
    {
        public string File { get; } = Path.Combine(Path.GetTempPath(), "office-store-" + Guid.NewGuid().ToString("N"), "grants.json");
        public string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        public string Key { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        public DateTimeOffset Issued { get; } = DateTimeOffset.UtcNow;
        public Clock Clock { get; } = new();
        public OfficeEnrollmentOptions Options { get; }
        public Fixture()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(File)!);
            System.IO.File.WriteAllText(File, "[]");
            Clock.Now = Issued;
            Options = new OfficeEnrollmentOptions
            {
                Enabled = true, StateFile = File,
                Tokens = [new() { TokenHash = Hash(Token), IssuedUtc = Issued, ExpiresUtc = Issued.AddMinutes(30), DeviceExpiresUtc = Issued.AddDays(1) }]
            };
        }
        public OfficeEnrollmentStore Open() => new(Microsoft.Extensions.Options.Options.Create(Options), Clock);
        public bool Authenticate(OfficeEnrollmentStore store, string machine, string key)
        {
            var context = new DefaultHttpContext();
            context.Request.Headers["X-Mashura-Machine-Id"] = machine;
            context.Request.Headers["X-Mashura-Agent-Key"] = key;
            return store.Authenticate(context, new AgentAuthOptions()).IsAuthenticated;
        }
        public void Dispose() => Directory.Delete(Path.GetDirectoryName(File)!, recursive: true);
    }
}

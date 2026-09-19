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

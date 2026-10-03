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

    [Fact]
    public void Revoke_tombstones_grant_once_and_denies_old_key_after_restart()
    {
        using var fixture = new Fixture();
        var renewal = Guid.NewGuid();
        using (var store = fixture.Open())
        {
            Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
            Assert.NotNull(store.Renew("device", renewal, "supervisor-id", "lab repeat"));
            Assert.True(fixture.Authenticate(store, "device", fixture.Key));
            Assert.True(store.Revoke("device"));
            Assert.False(fixture.Authenticate(store, "device", fixture.Key));
            Assert.False(store.Redeem(fixture.Token, "device", fixture.Key));
            Assert.Null(store.Renew("device", Guid.NewGuid(), "supervisor-id", "lab repeat"));
            var tombstone = File.ReadAllText(fixture.File);
            var grant = Assert.Single(System.Text.Json.JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(tombstone)!);
            Assert.True(grant.Revoked);
            Assert.True(grant.KeyDestroyed);
            Assert.NotEqual(Hash(fixture.Key), grant.KeyHash);
            Assert.Equal(renewal, Assert.Single(grant.Renewals).RequestId);
            Assert.False(store.Revoke("device"));
            Assert.Equal(tombstone, File.ReadAllText(fixture.File));
        }
        using var reopened = fixture.Open();
        Assert.False(fixture.Authenticate(reopened, "device", fixture.Key));
        Assert.False(reopened.Redeem(fixture.Token, "device", fixture.Key));
        Assert.Null(reopened.Renew("device", Guid.NewGuid(), "supervisor-id", "lab repeat"));
        Assert.False(reopened.Revoke("device"));
    }

    [Fact]
    public void Revoke_no_ops_without_a_live_grant_or_office_mode()
    {
        using var fixture = new Fixture();
        using (var store = fixture.Open())
        {
            Assert.False(store.Revoke("missing"));
            Assert.False(store.Revoke("../device"));
            Assert.False(store.Revoke(""));
            Assert.Equal("[]", File.ReadAllText(fixture.File));
        }
        fixture.Options.Enabled = false;
        using var disabled = fixture.Open();
        Assert.False(disabled.Revoke("device"));
        Assert.Equal("[]", File.ReadAllText(fixture.File));
    }

    [Fact]
    public void Revoke_refuses_missing_journal_without_mutating_grant()
    {
        using var fixture = new Fixture();
        using var store = fixture.Open();
        Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        var backup = fixture.File + ".backup";
        File.Move(fixture.File, backup);
        try
        {
            Assert.Throws<IOException>(() => store.Revoke("device"));
            Assert.True(fixture.Authenticate(store, "device", fixture.Key));
        }
        finally { File.Move(backup, fixture.File); }
        Assert.True(fixture.Authenticate(store, "device", fixture.Key));
        Assert.True(store.Revoke("device"));
    }

    [Fact]
    public void Revoke_write_failure_keeps_old_grant_until_retry()
    {
        if (OperatingSystem.IsWindows()) return; // Unix directory mode is the fault injection.
        using var fixture = new Fixture();
        using var store = fixture.Open();
        Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        var before = File.ReadAllText(fixture.File);
        var directory = Path.GetDirectoryName(fixture.File)!;
        var mode = File.GetUnixFileMode(directory);
        try
        {
            File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserExecute);
            var failure = Record.Exception(() => store.Revoke("device"));
            Assert.True(failure is IOException or UnauthorizedAccessException, $"Unexpected failure: {failure?.GetType().Name}");
            Assert.True(fixture.Authenticate(store, "device", fixture.Key));
            Assert.Equal(before, File.ReadAllText(fixture.File));
        }
        finally { File.SetUnixFileMode(directory, mode); }
        Assert.True(store.Revoke("device"));
        Assert.False(fixture.Authenticate(store, "device", fixture.Key));
    }

    [Fact]
    public void Readback_rejects_oversized_journal()
    {
        using var fixture = new Fixture();
        using var store = fixture.Open();
        Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        Assert.True(store.Revoke("device"));
        using (var file = new FileStream(fixture.File, FileMode.Append, FileAccess.Write))
            file.SetLength(4 * 1024 * 1024 + 1);
        Assert.False(store.HasDurableRevocation("device"));
    }

    [Fact]
    public void Readback_rejects_replaced_journal_path()
    {
        using var fixture = new Fixture();
        using var store = fixture.Open();
        Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        Assert.True(store.Revoke("device"));
        File.Move(fixture.File, fixture.File + ".old");
        File.WriteAllText(fixture.File, "[]");
        Assert.False(store.HasDurableRevocation("device"));
        File.Delete(fixture.File);
        File.Move(fixture.File + ".old", fixture.File);
        Assert.True(store.HasDurableRevocation("device"));
    }

    [Theory]
    [InlineData("destroyedWithoutRevocation")]
    [InlineData("nullRenewals")]
    [InlineData("invalidRenewal")]
    [InlineData("duplicateRequest")]
    public void Readback_rejects_unrelated_corrupt_grant(string corruption)
    {
        using var fixture = new Fixture();
        using var store = fixture.Open();
        Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        Assert.True(store.Revoke("device"));
        var original = System.Text.Json.JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(File.ReadAllText(fixture.File))!;
        var id = Guid.NewGuid();
        var renewal = new OfficeEnrollmentStore.Renewal(id, "actor", "reason", fixture.Issued, fixture.Issued.AddDays(1));
        var other = new OfficeEnrollmentStore.Grant(Hash(fixture.Key), "other", Hash(fixture.Token)) { Renewals = [renewal] };
        var grants = corruption switch
        {
            "destroyedWithoutRevocation" => new[] { original[0], other with { KeyDestroyed = true } },
            "nullRenewals" => new[] { original[0], other with { Renewals = null! } },
            "invalidRenewal" => new[] { original[0], other with { Renewals = [renewal with { ExpiresUtc = renewal.IssuedUtc }] } },
            _ => new[] { original[0] with { Renewals = [renewal] }, other }
        };
        File.WriteAllText(fixture.File, System.Text.Json.JsonSerializer.Serialize(grants));
        Assert.False(store.HasDurableRevocation("device"));
        store.Dispose();
        Assert.Throws<InvalidOperationException>(() => fixture.Open()); // constructor uses the same invariants
    }

    [Fact]
    public void Bounded_reader_rejects_source_that_grows_during_read()
    {
        using var source = new GrowingStream(Encoding.UTF8.GetBytes("[]"));
        Assert.Null(OfficeEnrollmentStore.ReadBoundedJournal(source));
    }

    private sealed class GrowingStream : MemoryStream
    {
        private bool _grew;
        public GrowingStream(byte[] initial)
        {
            Write(initial);
            Position = 0;
        }
        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = base.Read(buffer, offset, count);
            if (!_grew)
            {
                _grew = true;
                var position = Position;
                SetLength(4 * 1024 * 1024 + 1);
                Position = position;
            }
            return read;
        }
    }

    [Fact]
    public void Readback_rejects_overflowed_renewal_dates()
    {
        using var fixture = new Fixture();
        using var store = fixture.Open();
        Assert.True(store.Redeem(fixture.Token, "device", fixture.Key));
        Assert.True(store.Revoke("device"));
        var original = System.Text.Json.JsonSerializer.Deserialize<List<OfficeEnrollmentStore.Grant>>(File.ReadAllText(fixture.File))!;
        var invalid = new OfficeEnrollmentStore.Renewal(Guid.NewGuid(), "actor", "reason", DateTimeOffset.MaxValue, DateTimeOffset.MaxValue);
        File.WriteAllText(fixture.File, System.Text.Json.JsonSerializer.Serialize(new[] { original[0] with { Renewals = [invalid] } }));
        Assert.False(store.HasDurableRevocation("device"));
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

using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Packages;
using Cabinet.Agent.Core.Writes;
using Cabinet.Agent.Windows;
using Xunit;

namespace Cabinet.Agent.Windows.Tests;

public sealed class TestClock(DateTimeOffset start) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = start;
    public override DateTimeOffset GetUtcNow() => Now;
}

/// <summary>
/// The write operations against this machine's real firewall and network settings (the CI runner is an
/// administrator). Every change is either confirmed and then undone by the test, or rolled back by the
/// safety net, which is what the test checks.
/// </summary>
public sealed class WriteOperationTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("cabinet-writes-").FullName;
    private readonly TestClock _clock = new(DateTimeOffset.UtcNow);
    private readonly FirewallCom _fw = new();
    private readonly NetworkControl _net = new();
    private readonly List<string> _log = new();

    private SafetyNet Safety() => new(Path.Combine(_dir, "safety.json"), _clock);
    private FirewallStore Store() => new(Path.Combine(_dir, "firewall"));
    private BrokerWrites Writes() => new(_fw, _net, Safety(), Store(), _clock, _log.Add);

    private static T As<T>(Guid command, Func<T> f) => OperationContext.RunAsync(command, () => Task.FromResult(f())).GetAwaiter().GetResult();

    public void Dispose()
    {
        foreach (var r in FirewallCom.Read(CancellationToken.None).Rules.Where(r => r.Name.StartsWith("MashuraDiag CI ", StringComparison.Ordinal)).ToList())
            try { _fw.DeleteRule(r.Name); } catch (OperationFailedException) { }
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }

    private static FirewallRule Rule(string name) => new()
    {
        Name = name, Direction = FirewallDirection.Out, Action = FirewallAction.Block, Protocol = FirewallProtocol.Tcp,
        RemotePorts = [new PortRange { From = 9, To = 9 }], RemoteAddresses = ["203.0.113.7"], Profiles = [], Enabled = true,
    };

    [Fact]
    public void A_rule_is_created_changed_and_deleted_and_an_unconfirmed_one_is_rolled_back()
    {
        string kept = "MashuraDiag CI " + Guid.NewGuid().ToString("N")[..8];
        Guid create = Guid.NewGuid();
        var created = As(create, () => Writes().SetRule(new FirewallSetRuleParams { Change = RuleChange.Create, Rule = Rule(kept) }));
        Assert.Null(created.Before);
        Assert.Equal(kept, created.After!.Name);
        Assert.Equal("TCP", created.After.Protocol);
        Assert.Equal("9", created.After.RemotePorts);
        Assert.True(created.After.CreatedByPlatform);
        Assert.Equal(SafetyNetState.Kept, Safety().Confirm(create).State);

        Guid disable = Guid.NewGuid();
        var disabled = As(disable, () => Writes().SetRule(new FirewallSetRuleParams { Change = RuleChange.Disable, RuleName = kept }));
        Assert.True(disabled.Before!.Enabled);
        Assert.False(disabled.After!.Enabled);
        Safety().Confirm(disable);

        // A second rule nobody confirms: the safety net puts the firewall back as it was before it.
        string unconfirmed = "MashuraDiag CI " + Guid.NewGuid().ToString("N")[..8];
        As(Guid.NewGuid(), () => Writes().SetRule(new FirewallSetRuleParams { Change = RuleChange.Create, Rule = Rule(unconfirmed) }));
        Assert.Equal(1, _fw.CountRules(unconfirmed));
        _clock.Now += TimeSpan.FromMinutes(3);
        Writes().Tick();
        Assert.Equal(0, _fw.CountRules(unconfirmed));
        Assert.False(_fw.ReadRule(kept)!.Enabled); // the confirmed changes stay

        Guid delete = Guid.NewGuid();
        var deleted = As(delete, () => Writes().SetRule(new FirewallSetRuleParams { Change = RuleChange.Delete, RuleName = kept }));
        Assert.Null(deleted.After);
        Safety().Confirm(delete);
        Assert.Equal(0, _fw.CountRules(kept));
        Assert.True(Store().Snapshots().Count >= 4);
    }

    [Fact]
    public void A_profile_turned_off_for_a_minute_comes_back_on_even_after_the_broker_restarts()
    {
        FirewallProfileState original = FirewallCom.Read(CancellationToken.None).Profiles.Single(p => p.Profile == FirewallProfile.Public);
        try
        {
            Guid off = Guid.NewGuid();
            var output = As(off, () => Writes().SetProfile(new FirewallSetProfileParams
            {
                Profile = FirewallProfile.Public, Enabled = false, DefaultInbound = original.DefaultInbound, DefaultOutbound = original.DefaultOutbound, DurationMinutes = 1,
            }));
            Assert.False(output.After.Enabled);
            Assert.Equal(_clock.Now.AddMinutes(1), output.After.ReenableAt);
            Safety().Confirm(off);
            Assert.False(FirewallCom.Read(CancellationToken.None).Profiles.Single(p => p.Profile == FirewallProfile.Public).Enabled);

            _clock.Now += TimeSpan.FromSeconds(61);
            Writes().Tick(); // a new instance: the timer is read back from disk
            Assert.True(FirewallCom.Read(CancellationToken.None).Profiles.Single(p => p.Profile == FirewallProfile.Public).Enabled);
            Assert.Empty(Store().TimersList());
        }
        finally { _fw.SetProfile(FirewallProfile.Public, original.Enabled, original.DefaultInbound, original.DefaultOutbound); }
    }

    private static (int Index, DnsSettings Dns)? MainAdapter()
    {
        var nic = NetworkInterface.GetAllNetworkInterfaces().FirstOrDefault(n => n.OperationalStatus == OperationalStatus.Up &&
            n.NetworkInterfaceType != NetworkInterfaceType.Loopback && n.GetIPProperties().GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork));
        if (nic is null) return null;
        int index = nic.GetIPProperties().GetIPv4Properties().Index;
        return (index, new NetworkControl().Read(index).Dns);
    }

    [Fact]
    public void A_dns_change_reports_before_and_after_and_is_rolled_back_without_confirmation()
    {
        var adapter = MainAdapter();
        Assert.NotNull(adapter);
        var (index, before) = adapter!.Value;
        Assert.NotEmpty(before.Servers);
        try
        {
            // The same servers, typed in by hand: a real change of mode that cannot break this machine.
            var output = As(Guid.NewGuid(), () => Writes().SetDns(new NetworkSetDnsParams { InterfaceIndex = index, Mode = DnsMode.Static, Servers = before.Servers }));
            Assert.Equal(before.Automatic, output.Before.Automatic);
            Assert.False(output.After.Automatic);
            Assert.Equal(before.Servers, output.After.Servers);
            _clock.Now += TimeSpan.FromMinutes(3);
            Writes().Tick();
            Assert.Equal(before.Automatic, _net.Read(index).Dns.Automatic);
        }
        finally { _net.SetDns(index, before); }
    }

    [Fact]
    public void Setting_dhcp_on_a_dhcp_adapter_reports_the_settings_and_keeps_them()
    {
        var adapter = MainAdapter();
        Assert.NotNull(adapter);
        var (ip, _) = _net.Read(adapter!.Value.Index);
        Assert.True(ip.Dhcp, "the CI runner's adapter uses DHCP");
        Guid cmd = Guid.NewGuid();
        var output = As(cmd, () => Writes().SetIp(new NetworkSetIpParams { InterfaceIndex = adapter.Value.Index, Mode = IpMode.Dhcp }));
        Assert.True(output.After.Dhcp);
        Assert.NotEmpty(output.Before.Addresses);
        Assert.Equal(SafetyNetState.Kept, Safety().Confirm(cmd).State);
        Assert.Equal("not_found", Assert.Throws<OperationFailedException>(() => _net.Read(999_999)).Code);
    }
}

/// <summary>
/// Real signed packages from this machine, prepared by the CI job into PACKAGE_FIXTURES: a third-party driver
/// already installed here (signed through Microsoft), the same driver with one file changed, a driver catalog
/// signed by an impostor certificate that carries Microsoft's publisher name, an unsigned catalog, and a
/// Microsoft-signed MSI (checked, not installed).
/// </summary>
public sealed class PackageWindowsTests : IDisposable
{
    private static readonly string? Fixtures = Environment.GetEnvironmentVariable("PACKAGE_FIXTURES");
    private readonly string _dir = Directory.CreateTempSubdirectory("cabinet-packages-").FullName;
    private readonly List<string> _log = new();

    public void Dispose() { try { Directory.Delete(_dir, true); } catch (IOException) { } }

    private string Fixture(string name)
    {
        Assert.False(string.IsNullOrEmpty(Fixtures), "PACKAGE_FIXTURES is not set (the CI job prepares it)");
        string path = Path.Combine(Fixtures!, name);
        Assert.True(File.Exists(path), $"{name} was not prepared");
        return path;
    }

    private string Run(string fixture, PackageType type = PackageType.Driver, string? sha = null)
    {
        Guid id = Guid.NewGuid();
        string downloads = Path.Combine(_dir, "downloads"), staging = Path.Combine(_dir, "staging");
        Directory.CreateDirectory(downloads);
        File.Copy(fixture, PackageInstaller.DownloadPath(downloads, id));
        string actual = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(fixture))).ToLowerInvariant();
        var installer = new PackageInstaller(downloads, staging, TrustList.Compiled, new PackagePlatform(_log.Add), _log.Add);
        try
        {
            var output = OperationContext.RunAsync(Guid.NewGuid(), () => Task.FromResult(installer.Install(new PackageInstallParams { PackageId = id, PackageType = type, Sha256 = sha ?? actual })))
                .GetAwaiter().GetResult();
            return "installed:" + output.Signer;
        }
        catch (OperationFailedException e) { return e.Code; }
        finally { Assert.Empty(Directory.EnumerateFileSystemEntries(staging)); }
    }

    [Fact]
    public void A_driver_signed_through_microsoft_passes_every_check_and_installs()
    {
        string result = Run(Fixture("oem-driver.zip"));
        Assert.True(result.StartsWith("installed:", StringComparison.Ordinal), $"{result}\n{string.Join("\n", _log)}");
    }

    [Fact]
    public void The_same_driver_with_one_file_changed_is_refused()
    {
        Assert.Equal("signature_invalid", Run(Fixture("tampered-driver.zip")));
    }

    [Fact]
    public void A_catalog_signed_by_an_impostor_with_microsofts_name_is_refused()
    {
        Assert.Equal("publisher_not_trusted", Run(Fixture("impostor-driver.zip")));
    }

    [Fact]
    public void An_unsigned_catalog_is_refused()
    {
        Assert.Equal("signature_invalid", Run(Fixture("unsigned-driver.zip")));
    }

    [Fact]
    public void A_package_whose_hash_differs_from_the_approved_one_is_refused()
    {
        Assert.Equal("hash_mismatch", Run(Fixture("oem-driver.zip"), sha: new string('0', 64)));
    }

    [Fact]
    public void A_microsoft_signed_msi_passes_windows_trust_and_the_publisher_list()
    {
        string msi = Fixture("microsoft.msi");
        var platform = new PackagePlatform(_log.Add);
        platform.VerifyWithWindows(msi);
        var (signer, certs) = platform.ReadMsiSignature(msi);
        var match = TrustList.Compiled.Match(signer, certs, PackageType.Msi);
        Assert.True(match is not null, $"signer {signer.Subject}, chain certs: {string.Join(" | ", certs.Select(c => c.Subject))}");
        Assert.Null(TrustList.Compiled.Match(signer, certs, PackageType.Driver));
    }

    [Fact]
    public void A_file_that_is_not_signed_fails_windows_trust()
    {
        string path = Path.Combine(_dir, "not-signed.msi");
        File.WriteAllBytes(path, RandomNumberGenerator.GetBytes(4096));
        Assert.Equal("signature_invalid", Assert.Throws<PackageRefusedException>(() => new PackagePlatform(_log.Add).VerifyWithWindows(path)).Code);
    }
}

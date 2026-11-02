using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

/// <summary>
/// Text from Windows is longer than the contracts allow more often than not (a real cabinet's longest reliability message was 720
/// characters). Each record is shaped by the same function the Windows read uses, put in its operation's whole output, and checked
/// against the contract: one over-long field used to fail the entire read (product test 2026-11-02, finding 1).
/// </summary>
public sealed class InventoryContractCapsTests
{
    private static readonly string Long = string.Concat(Enumerable.Repeat("Windows wrote a long message here. ", 40)); // 1,400 characters
    private static readonly DateTimeOffset Now = new(2026, 11, 2, 18, 7, 42, TimeSpan.Zero);

    private static void MatchesContract(string operation, object output) =>
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(operation), JsonSerializer.SerializeToElement(output, ContractJson.Options)));

    [Fact]
    public void A_long_reliability_message_keeps_the_read_within_its_contract()
    {
        var output = new ReliabilityListOutput
        {
            TakenAt = Now, Truncated = false,
            Records = [InventoryRules.ReliabilityRecordFor(Now, Long, Long, 1001, Long + "\r\nsecond line"), InventoryRules.ReliabilityRecordFor(Now, null, null, null, null)],
        };
        MatchesContract(Catalog.ReliabilityList, output);
        Assert.StartsWith("Windows wrote a long message", output.Records[0].Message); // shortened, not dropped
    }

    [Fact]
    public void A_long_dns_cache_answer_keeps_the_read_within_its_contract()
    {
        var output = new DnsCacheOutput
        {
            TakenAt = Now, Truncated = false,
            Entries = [InventoryRules.DnsCacheEntryFor("sync.example.local", 16, Long, 300)!, InventoryRules.DnsCacheEntryFor(new string('a', 400), 1, "10.0.0.1", -5)!],
        };
        MatchesContract(Catalog.DnsCache, output);
        Assert.Null(InventoryRules.DnsCacheEntryFor("  ", 1, "10.0.0.1", 60)); // no name, no entry
    }

    [Fact]
    public void A_long_certificate_subject_keeps_the_security_read_within_its_contract()
    {
        var output = new SystemSecurityOutput
        {
            TakenAt = Now, PendingReboot = new PendingReboot { Pending = false, Reasons = [] }, Defender = null, Bitlocker = [], Activation = null,
            Certificates = [InventoryRules.CertificateExpiryFor("Personal", "CN=" + Long, Now.AddDays(10), Now), InventoryRules.CertificateExpiryFor("Root", null, Now.AddDays(-1), Now)],
        };
        MatchesContract(Catalog.SystemSecurity, output);
        Assert.True(output.Certificates[1].Expired);
    }
}

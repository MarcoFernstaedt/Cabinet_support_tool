using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;
using Cabinet.Agent.Core.Monitoring;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

/// <summary>
/// Kernel-Power 41's own data (decision-log D19): only the four fields that say why the cabinet restarted are kept, only as numbers, only
/// for that event, and they reach the server in the event's detail within both contracts.
/// </summary>
public sealed class KernelPowerFieldsTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 3, 3, 14, 0, TimeSpan.Zero);
    private static KeyValuePair<string, string?> F(string name, string? value) => new(name, value);

    [Fact]
    public void Only_the_four_named_fields_are_kept_and_only_as_numbers()
    {
        var picked = KernelPowerFields.Pick([F("BugcheckCode", "209"), F("BugcheckParameter1", "0x28"), F("PowerButtonTimestamp", " 0 "), F("SleepInProgress", "0"),
            F("CommandLine", "cmd.exe /c whoami"), F("Data7", "5"), F("bugcheckcode", "999")]);
        Assert.NotNull(picked);
        Assert.Equal(new Dictionary<string, string> { ["BugcheckCode"] = "209", ["BugcheckParameter1"] = "0x28", ["PowerButtonTimestamp"] = "0", ["SleepInProgress"] = "0" }, picked);
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("0x")]
    [InlineData("-1")]
    [InlineData("1e5")]
    [InlineData("209; DROP TABLE events")]
    [InlineData("0x12345678901234567")]
    [InlineData("123456789012345678901")]
    [InlineData("１２")]
    [InlineData(null)]
    public void A_value_that_is_not_a_plain_number_is_never_sent(string? value)
    {
        Assert.Null(KernelPowerFields.Pick([F("BugcheckCode", value)]));
    }

    [Fact]
    public void Only_Kernel_Power_41_qualifies()
    {
        Assert.True(KernelPowerFields.Applies("Microsoft-Windows-Kernel-Power", 41));
        Assert.True(KernelPowerFields.Applies("microsoft-windows-kernel-power", 41));
        Assert.False(KernelPowerFields.Applies("Microsoft-Windows-Kernel-Power", 42));
        Assert.False(KernelPowerFields.Applies("BugCheck", 41));
        Assert.False(KernelPowerFields.Applies(null, 41));
    }

    [Fact]
    public void The_query_output_with_fields_is_within_its_contract_and_the_watched_event_carries_them()
    {
        var entry = new EventSummary
        {
            RecordId = 4021, Time = Now, Level = EventLevel.Critical, Source = "Microsoft-Windows-Kernel-Power", EventId = 41,
            FirstLine = "The system has rebooted without cleanly shutting down first.",
            Fields = KernelPowerFields.Pick([F("BugcheckCode", "0"), F("PowerButtonTimestamp", "133457952000000000"), F("SleepInProgress", "0")]),
        };
        var output = new EventlogQueryOutput { Log = "System", Entries = [entry], NextBeforeRecordId = null, Truncated = false };
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Output(Catalog.EventlogQuery), JsonSerializer.SerializeToElement(output, ContractJson.Options)));

        AgentEvent ev = EventLogWatch.ToEvent("System", entry);
        Assert.Equal("133457952000000000", ev.Detail!.Fields!["PowerButtonTimestamp"]);
        Assert.Empty(ContractSchemas.Instance.Validate(ContractSchemas.Envelope("event"), JsonSerializer.SerializeToElement(ev, ContractJson.Options)));
    }

    [Fact]
    public void Every_other_entry_sends_no_fields_at_all()
    {
        var entry = new EventSummary { RecordId = 7, Time = Now, Level = EventLevel.Error, Source = "disk", EventId = 7, FirstLine = "Bad block." };
        JsonElement json = JsonSerializer.SerializeToElement(entry, ContractJson.Options);
        Assert.False(json.TryGetProperty("fields", out _), "no fields key, not an empty one");
        Assert.Null(EventLogWatch.ToEvent("System", entry).Detail!.Fields);
    }
}

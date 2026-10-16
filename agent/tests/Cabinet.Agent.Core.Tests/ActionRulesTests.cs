using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Writes;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

public class ActionRulesTests
{
    [Theory]
    [InlineData(4L, "System")] [InlineData(1L, "x.exe")] [InlineData(612L, "lsass.exe")] [InlineData(612L, "LSASS.EXE")] [InlineData(612L, "svchost")] [InlineData(700L, "MsMpEng.exe")]
    [InlineData(700L, "TeamViewer.exe")] [InlineData(700L, "Cabinet.Agent.Network.exe")] [InlineData(700L, "MashuraSomething.exe")] [InlineData(700L, "CABINETAGENTBROKER.exe")]
    public void Protected_processes_are_refused(long pid, string name) => Assert.NotNull(ActionRules.WhyNotEnd(pid, name, ownProcessId: 9999));

    [Theory]
    [InlineData(4821L, "notepad.exe")] [InlineData(4821L, "BioScanApp.exe")] [InlineData(4821L, "notepad")] [InlineData(4821L, "svchost-lookalike.exe")]
    public void Ordinary_processes_may_be_ended(long pid, string name) => Assert.Null(ActionRules.WhyNotEnd(pid, name, ownProcessId: 9999));

    [Fact]
    public void The_agents_own_process_id_is_refused_whatever_it_is_called() => Assert.NotNull(ActionRules.WhyNotEnd(9999, "anything.exe", 9999));

    [Fact]
    public void Restart_arguments_are_separate_elements_and_a_message_cannot_become_a_switch()
    {
        var args = ActionRules.RestartArguments(new SystemRestartParams { Mode = RestartMode.Restart, DelaySeconds = 300, Message = "/s /t 0 & calc.exe\r\n/f" });
        Assert.Equal(["/r", "/t", "300", "/d", "p:0:0", "/c"], args.Take(6));
        Assert.Equal(7, args.Count);
        Assert.DoesNotContain('\n', args[6]);
        Assert.DoesNotContain('\r', args[6]);
        Assert.DoesNotContain("/f", args.Take(6));
    }

    [Fact]
    public void Shutdown_cancel_and_no_message()
    {
        Assert.Equal(["/s", "/t", "0", "/d", "p:0:0"], ActionRules.RestartArguments(new SystemRestartParams { Mode = RestartMode.Shutdown }));
        Assert.Equal(["/a"], ActionRules.RestartArguments(new SystemRestartParams { Mode = RestartMode.Cancel }));
        Assert.Equal(5, ActionRules.RestartArguments(new SystemRestartParams { Mode = RestartMode.Restart, Message = "   " }).Count);
    }

    [Theory]
    [InlineData(0, "No component store corruption detected.", ComponentStoreState.Healthy)]
    [InlineData(0, "The component store is repairable.", ComponentStoreState.Repairable)]
    [InlineData(0, "The component store is not repairable.", ComponentStoreState.Corrupt)]
    [InlineData(87, "Error: 87\nThe check-health option is unknown.", ComponentStoreState.Unknown)]
    [InlineData(0, "", ComponentStoreState.Unknown)]
    [InlineData(0, "Der Komponentenspeicher ist in Ordnung.", ComponentStoreState.Unknown)]
    public void Dism_answers_are_read_exactly_or_called_unknown(int code, string output, ComponentStoreState expected) => Assert.Equal(expected, ActionRules.ReadDism(code, output).State);

    [Fact]
    public void Dism_text_is_flattened_and_capped()
    {
        var (state, summary) = ActionRules.ReadDism(5, new string('x', 5000) + "\u0000\r\n");
        Assert.Equal(ComponentStoreState.Unknown, state);
        Assert.True(summary.Length <= 200);
    }
}

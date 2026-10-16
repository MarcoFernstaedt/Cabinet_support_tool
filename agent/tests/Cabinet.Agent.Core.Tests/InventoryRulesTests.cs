using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

public class InventoryRulesTests
{
    [Theory]
    [InlineData(0L, "Data", ShareKind.Disk)]
    [InlineData(1L, "Label", ShareKind.Print)]
    [InlineData(2147483648L, "C$", ShareKind.Admin)]
    [InlineData(2147483648L, "ADMIN$", ShareKind.Admin)]
    [InlineData(2147483651L, "IPC$", ShareKind.Ipc)]
    [InlineData(2L, "Dev", ShareKind.Other)]
    [InlineData(null, "x", ShareKind.Other)]
    [InlineData(-5L, "x", ShareKind.Other)]
    public void Share_kinds(long? type, string name, ShareKind expected) => Assert.Equal(expected, InventoryRules.ShareKindFor(type, name));

    [Theory]
    [InlineData(1L, TaskState.Disabled)] [InlineData(3L, TaskState.Ready)] [InlineData(4L, TaskState.Running)] [InlineData(99L, TaskState.Unknown)] [InlineData(null, TaskState.Unknown)]
    public void Task_states(long? code, TaskState expected) => Assert.Equal(expected, InventoryRules.TaskStateFor(code));

    [Fact]
    public void Sessions_are_classified()
    {
        Assert.Equal(SessionState.Active, InventoryRules.SessionStateFor(0));
        Assert.Equal(SessionState.Other, InventoryRules.SessionStateFor(-1));
        Assert.Equal(SessionType.Remote, InventoryRules.SessionTypeFor("RDP-Tcp#3"));
        Assert.Equal(SessionType.Console, InventoryRules.SessionTypeFor("Console"));
    }

    [Theory]
    [InlineData("Application Error", 1000L, ReliabilityKind.AppCrash)]
    [InlineData("Application Hang", 1002L, ReliabilityKind.AppHang)]
    [InlineData("Microsoft-Windows-Kernel-Power", 41L, ReliabilityKind.WindowsFailure)]
    [InlineData("Microsoft-Windows-WindowsUpdateClient", 20L, ReliabilityKind.UpdateFailure)]
    [InlineData("Something", null, ReliabilityKind.Other)]
    public void Reliability_kinds(string source, long? id, ReliabilityKind expected) => Assert.Equal(expected, InventoryRules.ReliabilityKindFor(source, id));

    [Fact]
    public void Days_are_clamped_and_ages_ignore_the_future()
    {
        var now = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        Assert.Equal(10, InventoryRules.DaysLeft(now.AddDays(10.5), now));
        Assert.Equal(-1, InventoryRules.DaysLeft(now.AddHours(-1), now));
        Assert.Equal(36_500, InventoryRules.DaysLeft(DateTimeOffset.MaxValue, now));
        Assert.Equal(3, InventoryRules.AgeDays(now.AddDays(-3), now));
        Assert.Null(InventoryRules.AgeDays(now.AddDays(30), now));
        Assert.Null(InventoryRules.AgeDays(null, now));
    }

    [Fact]
    public void Hostile_text_is_flattened_capped_or_dropped()
    {
        Assert.Null(InventoryRules.Clean("  \r\n\t ", 10));
        Assert.Null(InventoryRules.Clean(null, 10));
        Assert.Equal("a  b", InventoryRules.Clean("a\u0000\nb", 10));
        Assert.Equal(5, InventoryRules.Clean(new string('x', 500), 5)!.Length);
    }

    [Theory]
    [InlineData("20240115", "2024-01-15")] [InlineData("20241315", null)] [InlineData("2024011", null)] [InlineData("2024-1-5", null)] [InlineData("abcdefgh", null)] [InlineData("18000101", null)] [InlineData(null, null)]
    public void Registry_dates(string? text, string? expected) => Assert.Equal(expected, InventoryRules.CompactDate(text));

    [Fact]
    public void Bound_reports_truncation()
    {
        var (a, cutA) = InventoryRules.Bound(Enumerable.Range(0, 5), 5);
        Assert.Equal(5, a.Count); Assert.False(cutA);
        var (b, cutB) = InventoryRules.Bound(Enumerable.Range(0, 6), 5);
        Assert.Equal(5, b.Count); Assert.True(cutB);
    }
}

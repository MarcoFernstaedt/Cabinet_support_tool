using Cabinet.Agent.Core.Helpers;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

public class HealthMathTests
{
    private static HealthMath.CpuTimes T(ulong idle, ulong kernel, ulong user) => new(idle, kernel, user);

    [Fact]
    public void Cpu_percent_is_busy_time_over_total_time_with_idle_counted_in_kernel_time()
    {
        // 1000 ticks passed (kernel 800 of which 700 idle, user 200): 300 busy.
        Assert.Equal(30, HealthMath.CpuPercent(T(0, 0, 0), T(700, 800, 200)));
        Assert.Equal(100, HealthMath.CpuPercent(T(0, 0, 0), T(0, 500, 500)));
        Assert.Equal(0, HealthMath.CpuPercent(T(0, 0, 0), T(1000, 1000, 0)));
    }

    [Theory]
    [InlineData(10UL, 10UL, 10UL, 10UL, 10UL, 10UL)]   // nothing moved
    [InlineData(10UL, 10UL, 10UL, 5UL, 20UL, 20UL)]    // idle went backwards
    [InlineData(10UL, 10UL, 10UL, 20UL, 5UL, 20UL)]    // kernel went backwards
    public void Counters_that_did_not_move_forward_give_no_percentage(ulong i0, ulong k0, ulong u0, ulong i1, ulong k1, ulong u1) =>
        Assert.Null(HealthMath.CpuPercent(T(i0, k0, u0), T(i1, k1, u1)));

    [Fact]
    public void Idle_larger_than_total_is_zero_percent_not_negative() => Assert.Equal(0, HealthMath.CpuPercent(T(0, 0, 0), T(2000, 1000, 0)));

    [Theory]
    [InlineData(50L, 100L, 50)] [InlineData(0L, 100L, 0)] [InlineData(100L, 100L, 100)] [InlineData(150L, 100L, 100)]
    public void Free_percent_is_clamped(long free, long total, int expected) => Assert.Equal(expected, HealthMath.FreePercent(free, total));

    [Theory]
    [InlineData(5L, 0L)] [InlineData(5L, -1L)] [InlineData(-1L, 100L)]
    public void A_drive_with_no_size_or_a_negative_value_gives_nothing(long free, long total) => Assert.Null(HealthMath.FreePercent(free, total));
}

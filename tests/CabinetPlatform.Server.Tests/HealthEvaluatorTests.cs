using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Services;

namespace CabinetPlatform.Server.Tests;

public sealed class HealthEvaluatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 19, 18, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData("all")]
    [InlineData("cpu")]
    [InlineData("ram")]
    [InlineData("diskSpace")]
    [InlineData("updates")]
    [InlineData("clock")]
    public void Missing_required_measurement_is_unknown(string missing)
    {
        Assert.Equal(CabinetHealthStatus.Unknown, HealthEvaluator.Evaluate(
            true, Now, Now, 20,
            missing is "all" or "cpu" ? null : 10,
            missing is "all" or "ram" ? null : 20,
            missing is "all" or "diskSpace" ? null : 50,
            missing is "all" or "updates" ? null : 0,
            DiskHealthStatus.Unknown,
            missing is "all" or "clock" ? null : TimeSpan.Zero));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(DiskHealthStatus.Unknown)]
    [InlineData(DiskHealthStatus.Healthy)]
    public void Complete_normal_metrics_do_not_require_smart_support(DiskHealthStatus? diskHealth)
    {
        Assert.Equal(CabinetHealthStatus.Healthy, HealthEvaluator.Evaluate(
            true, Now, Now, 20, 10, 20, 50, 0, diskHealth, TimeSpan.Zero));
    }

    [Theory]
    [InlineData(5d, null, null, null, null, null, CabinetHealthStatus.Critical)]
    [InlineData(null, 95d, null, null, null, null, CabinetHealthStatus.Critical)]
    [InlineData(null, null, null, null, DiskHealthStatus.Failing, null, CabinetHealthStatus.Critical)]
    [InlineData(null, null, null, null, null, -600d, CabinetHealthStatus.Critical)]
    [InlineData(12d, null, null, null, null, null, CabinetHealthStatus.Warning)]
    [InlineData(null, 88d, null, null, null, null, CabinetHealthStatus.Warning)]
    [InlineData(null, null, 90d, null, null, null, CabinetHealthStatus.Warning)]
    [InlineData(null, null, null, 15, null, null, CabinetHealthStatus.Warning)]
    [InlineData(null, null, null, null, DiskHealthStatus.Watch, null, CabinetHealthStatus.Warning)]
    [InlineData(null, null, null, null, null, 120d, CabinetHealthStatus.Warning)]
    public void Known_adverse_evidence_outranks_missing_measurements(
        double? free, double? ram, double? cpu, int? updates, DiskHealthStatus? disk,
        double? driftSeconds, CabinetHealthStatus expected)
    {
        Assert.Equal(expected, HealthEvaluator.Evaluate(true, Now, Now, 20,
            cpu, ram, free, updates, disk,
            driftSeconds is { } seconds ? TimeSpan.FromSeconds(seconds) : null));
    }

    [Fact]
    public void Existing_availability_precedence_is_preserved()
    {
        Assert.Equal(CabinetHealthStatus.Unknown,
            HealthEvaluator.Evaluate(false, Now, Now, 20, null, null, null, null, DiskHealthStatus.Failing, null));
        Assert.Equal(CabinetHealthStatus.Unknown,
            HealthEvaluator.Evaluate(true, null, Now, 20, null, null, null, null, DiskHealthStatus.Failing, null));
        Assert.Equal(CabinetHealthStatus.Offline,
            HealthEvaluator.Evaluate(true, Now.AddMinutes(-21), Now, 20, null, null, null, null, DiskHealthStatus.Failing, null));
    }

    [Fact]
    public void Site_rollup_preserves_unknown_without_hiding_known_problems()
    {
        Assert.Equal(CabinetHealthStatus.Unknown, HealthEvaluator.Worse(CabinetHealthStatus.Healthy, CabinetHealthStatus.Unknown));
        Assert.Equal(CabinetHealthStatus.Warning, HealthEvaluator.Worse(CabinetHealthStatus.Unknown, CabinetHealthStatus.Warning));
        Assert.Equal(CabinetHealthStatus.Critical, HealthEvaluator.Worse(CabinetHealthStatus.Critical, CabinetHealthStatus.Unknown));
    }
}

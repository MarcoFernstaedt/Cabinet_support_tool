using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Tests.Collectors;

public class DiskHealthEvaluatorTests
{
    [Fact]
    public void Evaluate_ReturnsUnknownWhenSmartIsUnavailable()
    {
        Assert.Equal(DiskHealthStatus.Unknown, DiskHealthEvaluator.Evaluate(null));
    }

    [Fact]
    public void Evaluate_ReturnsUnknownWhenNoCounterWasReadable()
    {
        // A SmartInfo whose every field is null carries no evidence of health.
        var smart = new SmartInfo
        {
            Source = SmartSource.FailurePredictData, PowerOnHours = 900 };

        Assert.Equal(DiskHealthStatus.Unknown, DiskHealthEvaluator.Evaluate(smart));
    }

    [Fact]
    public void Evaluate_ReturnsFailingWhenTheDrivePredictsItsOwnFailure()
    {
        var smart = new SmartInfo
        {
            Source = SmartSource.FailurePredictData,
            OverallPredictFailure = true,
            ReallocatedSectorCount = 0,
            PendingSectorCount = 0,
        };

        Assert.Equal(DiskHealthStatus.Failing, DiskHealthEvaluator.Evaluate(smart));
    }

    [Fact]
    public void Evaluate_PrefersFailingOverWatch()
    {
        var smart = new SmartInfo
        {
            Source = SmartSource.FailurePredictData,
            OverallPredictFailure = true,
            ReallocatedSectorCount = 40,
        };

        Assert.Equal(DiskHealthStatus.Failing, DiskHealthEvaluator.Evaluate(smart));
    }

    [Theory]
    [InlineData(1, 0, 0)]
    [InlineData(0, 1, 0)]
    [InlineData(0, 0, 1)]
    public void Evaluate_ReturnsWatchWhenABadSectorCounterIsAboveZero(
        int reallocated,
        int pending,
        int uncorrectable)
    {
        var smart = new SmartInfo
        {
            Source = SmartSource.FailurePredictData,
            OverallPredictFailure = false,
            ReallocatedSectorCount = reallocated,
            PendingSectorCount = pending,
            UncorrectableErrorCount = uncorrectable,
        };

        Assert.Equal(DiskHealthStatus.Watch, DiskHealthEvaluator.Evaluate(smart));
    }

    [Fact]
    public void Evaluate_ReturnsHealthyWhenEveryReadableCounterIsClean()
    {
        var smart = new SmartInfo
        {
            Source = SmartSource.FailurePredictData,
            OverallPredictFailure = false,
            ReallocatedSectorCount = 0,
            PendingSectorCount = 0,
            UncorrectableErrorCount = 0,
            PowerOnHours = 26_304,
            TemperatureCelsius = 31,
        };

        Assert.Equal(DiskHealthStatus.Healthy, DiskHealthEvaluator.Evaluate(smart));
    }

    [Fact]
    public void Evaluate_TreatsAnUnreadableSectorCounterAsCleanOnlyWhenSomethingElseWasRead()
    {
        // Prediction was readable and clean, the sector counters were not.
        // That is enough to say Healthy, and importantly is not the same as
        // having read zeroes.
        var smart = new SmartInfo
        {
            Source = SmartSource.FailurePredictData, OverallPredictFailure = false };

        Assert.Equal(DiskHealthStatus.Healthy, DiskHealthEvaluator.Evaluate(smart));
    }
}

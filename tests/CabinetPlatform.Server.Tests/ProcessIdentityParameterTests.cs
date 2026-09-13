using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Services;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Tests;

public sealed class ProcessIdentityParameterTests
{
    internal static Dictionary<string, string> Parameters() => new()
    {
        [ActionParameterKeys.ProcessId] = "900",
        [ActionParameterKeys.ExpectedProcessName] = "LabApp",
        [ActionParameterKeys.ExpectedCreationTimeFileTime] = "133700000000000001",
        [ActionParameterKeys.ExpectedExecutablePath] = @"C:\Lab\LabApp.exe",
    };
    private static ActionParameterValidator Validator() => new(
        new ServiceAllowList(Options.Create(new ServiceAllowListOptions())),
        new ProcessAllowList(Options.Create(new ProcessControlOptions { Processes = ["LabApp"] })));

    [Theory]
    [InlineData("missing-creation")]
    [InlineData("missing-path")]
    [InlineData("fraction")]
    [InlineData("overflow")]
    [InlineData("zero")]
    [InlineData("signed")]
    [InlineData("whitespace")]
    [InlineData("pid-signed")]
    [InlineData("pid-whitespace")]
    [InlineData("relative-path")]
    [InlineData("control-path")]
    [InlineData("long-path")]
    public void Invalid_selected_identity_is_refused_without_repair(string defect)
    {
        var p = Parameters();
        switch (defect)
        {
            case "missing-creation": p.Remove(ActionParameterKeys.ExpectedCreationTimeFileTime); break;
            case "missing-path": p.Remove(ActionParameterKeys.ExpectedExecutablePath); break;
            case "fraction": p[ActionParameterKeys.ExpectedCreationTimeFileTime] = "133700000000000001.0"; break;
            case "overflow": p[ActionParameterKeys.ExpectedCreationTimeFileTime] = "9223372036854775808"; break;
            case "zero": p[ActionParameterKeys.ExpectedCreationTimeFileTime] = "0"; break;
            case "signed": p[ActionParameterKeys.ExpectedCreationTimeFileTime] = "+133700000000000001"; break;
            case "whitespace": p[ActionParameterKeys.ExpectedCreationTimeFileTime] = " 133700000000000001 "; break;
            case "pid-signed": p[ActionParameterKeys.ProcessId] = "+900"; break;
            case "pid-whitespace": p[ActionParameterKeys.ProcessId] = " 900 "; break;
            case "relative-path": p[ActionParameterKeys.ExpectedExecutablePath] = "LabApp.exe"; break;
            case "control-path": p[ActionParameterKeys.ExpectedExecutablePath] = "C:\\Lab\\LabApp.exe\0"; break;
            case "long-path": p[ActionParameterKeys.ExpectedExecutablePath] = @"C:\" + new string('x', 32765); break;
        }
        var result = Validator().Validate(ActionCatalog.Get(ActionName.KillProcess), p, DateTimeOffset.UtcNow);
        Assert.False(result.Succeeded);
    }

    [Fact]
    public void Path_length_exception_does_not_apply_to_other_operands_or_actions()
    {
        var p = Parameters();
        p[ActionParameterKeys.ExpectedProcessName] = new string('x', 257);
        Assert.False(Validator().Validate(ActionCatalog.Get(ActionName.KillProcess), p, DateTimeOffset.UtcNow).Succeeded);
        Assert.False(Validator().Validate(ActionCatalog.Get(ActionName.RestartApplication), Parameters(), DateTimeOffset.UtcNow).Succeeded);
    }

    [Theory]
    [InlineData(16)]
    [InlineData(300)]
    [InlineData(32767)]
    public void Complete_identity_accepts_comparison_path_without_truncation_or_normalization(int length)
    {
        var p = Parameters();
        var path = @"C:\" + new string('x', length - 3);
        p[ActionParameterKeys.ExpectedExecutablePath] = path;
        var result = Validator().Validate(ActionCatalog.Get(ActionName.KillProcess), p, DateTimeOffset.UtcNow);
        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal(p, result.Value);
    }
}

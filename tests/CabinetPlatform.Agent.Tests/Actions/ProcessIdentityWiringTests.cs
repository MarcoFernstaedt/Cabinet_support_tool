using System.Text.Json;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Console.Core.Sections;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Tests.Actions;

public sealed class ProcessIdentityWiringTests
{
    [Theory]
    [InlineData("null")]
    [InlineData("{\"processId\":900,\"processName\":\"LabApp\",\"creationTimeFileTime\":0,\"executablePath\":\"C:\\\\Lab\\\\LabApp.exe\"}")]
    [InlineData("{\"processId\":901,\"processName\":\"LabApp\",\"creationTimeFileTime\":133700000000000001,\"executablePath\":\"C:\\\\Lab\\\\LabApp.exe\"}")]
    [InlineData("{\"processId\":900,\"processName\":null,\"creationTimeFileTime\":133700000000000001,\"executablePath\":null}")]
    public void Missing_or_inconsistent_identity_keeps_observation_but_disables_selected_termination(string identity)
    {
        var info = JsonSerializer.Deserialize<ProcessInfo>(
            "{\"pid\":900,\"name\":\"LabApp\",\"selectionIdentity\":" + identity + "}", AgentJson.SerializerOptions)!;
        var section = new ProcessSectionViewModel();
        var action = new SectionActionViewModel(new ActionCatalogEntryDto
        {
            Action = ActionName.KillProcess, DisplayName = "End a process", Description = "Selected only",
            MinimumRole = CabinetPlatform.Contracts.Auth.Role.Tier1,
            RequiresApproval = true, IsDisruptive = false, TimeoutSeconds = 120,
            MaintenanceWindowOnly = false, BlockedIfUserLoggedOn = false, TargetsAnotherCabinet = false, Batchable = false,
        }, () => CabinetPlatform.Contracts.Auth.Role.Tier2, (_, _) => Task.CompletedTask);
        section.Actions.Add(action);
        section.ApplyProcesses([info], DateTimeOffset.UtcNow);
        section.SelectedProcess = Assert.Single(section.Processes);
        Assert.Equal("LabApp", section.SelectedProcess.Name);
        Assert.Empty(section.CurrentProcessIdParameters());
        Assert.False(action.InvokeCommand.CanExecute(null));
        Assert.Contains("identity unavailable", section.SelectedProcess.AccessibleSummary, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Observed_identity_survives_snapshot_collection_json_row_and_operands_exactly()
    {
        // The wire identity is nullable for older agents and inaccessible processes.
        var snapshot = JsonSerializer.Deserialize<ProcessSnapshot>("""
            {"pid":900,"name":"LabApp","selectionIdentity":{
              "processId":900,"processName":"LabApp","creationTimeFileTime":"133700000000000001",
              "executablePath":"C:\\Lab\\LabApp.exe"}}
            """, AgentJson.SerializerOptions)!;
        var infos = ProcessCpuCalculator.Combine([], [snapshot], TimeSpan.FromSeconds(1), 1, 100);
        var wire = JsonSerializer.Serialize(infos, AgentJson.SerializerOptions);
        var section = new ProcessSectionViewModel();
        section.ApplyProcesses(JsonSerializer.Deserialize<ProcessInfo[]>(wire, AgentJson.SerializerOptions)!, DateTimeOffset.UtcNow);
        section.SelectedProcess = Assert.Single(section.Processes);
        var parameters = section.CurrentProcessIdParameters();
        Assert.Equal(4, parameters.Count);
        Assert.Equal("900", parameters[ActionParameterKeys.ProcessId]);
        Assert.Equal("LabApp", parameters[ActionParameterKeys.ExpectedProcessName]);
        Assert.Equal("133700000000000001", parameters[ActionParameterKeys.ExpectedCreationTimeFileTime]);
        Assert.Equal(@"C:\Lab\LabApp.exe", parameters[ActionParameterKeys.ExpectedExecutablePath]);
        Assert.Contains("\"creationTimeFileTime\":\"133700000000000001\"", wire);
        section.ApplyProcesses(infos, DateTimeOffset.UtcNow);
        Assert.Null(section.SelectedProcess);
        Assert.Empty(section.CurrentProcessIdParameters());
    }
}

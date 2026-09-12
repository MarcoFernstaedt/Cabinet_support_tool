using System.Text.Json;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Tests.Transport;

/// <summary>
/// The agent serialises through the shared contract convention and nothing
/// else.
/// </summary>
/// <remarks>
/// <para>
/// This is a one-line test guarding a whole class of silent failure. An agent
/// with its own serializer settings, however similar they look, is an agent
/// that can drift: a converter added on one side, a naming policy changed on
/// the other, and a field quietly stops arriving while the check-in keeps
/// returning 200.
/// </para>
/// <para>
/// The server's round-trip test serialises with
/// <see cref="ContractJson.Default"/> on the grounds that it is what the agent
/// uses. This is where that claim is checked — the server test project cannot
/// reference the agent, which targets <c>net8.0-windows</c>.
/// </para>
/// </remarks>
public class AgentJsonTests
{
    [Fact]
    public void The_agent_serialises_through_the_shared_contract_convention()
    {
        Assert.Same(ContractJson.Default, AgentJson.SerializerOptions);
    }

    [Fact]
    public void An_enum_travels_as_its_name_and_an_unread_counter_is_omitted()
    {
        // Both halves of the convention, asserted on the type where getting
        // either wrong does the most damage. A numbered enum breaks a stored
        // payload the day somebody renumbers the enum; an emitted null would be
        // read back as a reading of zero by anything less careful than this
        // codebase.
        var smart = new SmartInfo
        {
            Source = SmartSource.FailurePredictData,
            ReallocatedSectorCount = 24,
        };

        string json = JsonSerializer.Serialize(smart, AgentJson.SerializerOptions);

        Assert.Contains("\"source\":\"FailurePredictData\"", json, StringComparison.Ordinal);
        Assert.Contains("\"reallocatedSectorCount\":24", json, StringComparison.Ordinal);

        // Not present at all, rather than present as null and certainly not as
        // zero.
        Assert.DoesNotContain("wear", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("powerOnHours", json, StringComparison.OrdinalIgnoreCase);

        // And reading it back leaves the absences absent.
        SmartInfo? read = JsonSerializer.Deserialize<SmartInfo>(json, AgentJson.SerializerOptions);

        Assert.NotNull(read);
        Assert.Equal(SmartSource.FailurePredictData, read!.Source);
        Assert.Equal(24, read.ReallocatedSectorCount);
        Assert.Null(read.Wear);
        Assert.Null(read.PowerOnHours);
    }
}

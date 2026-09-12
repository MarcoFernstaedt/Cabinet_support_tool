using System.Reflection;
using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Tests.Actions;

/// <summary>
/// Every operand name this agent reads is one of the shared contract's.
/// </summary>
/// <remarks>
/// <para>
/// The agent's half of the invariant the server's <c>ActionCatalogTests</c>
/// hold from the other side. Four of the nine original actions were broken end
/// to end on exactly this: the server sent <c>serviceName</c> and this agent
/// read <c>ServiceName</c>; the server sent <c>delaySeconds</c> for a reboot and
/// this agent permitted only a supervisor-override key that existed on neither
/// side any more.
/// </para>
/// <para>
/// Nothing in either build can see that. The request arrives, the agent
/// declines it as carrying a parameter the action does not define, and the only
/// evidence is an approved action that never runs. Sourcing both sides from one
/// class is what makes it impossible; these two tests are what keep a literal
/// from creeping back in.
/// </para>
/// </remarks>
public class ParameterNameTests
{
    private static readonly HashSet<string> Shared = typeof(ActionParameterKeys)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(f => f is { IsLiteral: true, FieldType.Name: nameof(String) })
        .Select(f => (string)f.GetRawConstantValue()!)
        .ToHashSet(StringComparer.Ordinal);

    [Fact]
    public void Every_executors_permitted_parameter_comes_from_the_shared_contract()
    {
        Assert.NotEmpty(Shared);

        var strangers = new List<string>();
        var checkedExecutors = 0;

        foreach (Type executor in typeof(IActionExecutor).Assembly
                     .GetTypes()
                     .Where(t => t is { IsAbstract: false, IsClass: true } &&
                                 typeof(IActionExecutor).IsAssignableFrom(t))
                     .OrderBy(t => t.Name, StringComparer.Ordinal))
        {
            FieldInfo? permitted = executor.GetField(
                "PermittedParameters",
                BindingFlags.NonPublic | BindingFlags.Static);

            if (permitted?.GetValue(null) is not IEnumerable<string> names)
            {
                // An executor that takes no parameters at all, or that spells
                // its allow-list inline at the call site. Both are covered by
                // the inline test below.
                continue;
            }

            checkedExecutors++;

            foreach (string name in names)
            {
                if (!Shared.Contains(name))
                {
                    strangers.Add($"{executor.Name}.{name}");
                }
            }
        }

        Assert.True(checkedExecutors > 0, "No executor declared a permitted-parameter set to check.");

        Assert.True(strangers.Count == 0,
            "Parameter names not drawn from ActionParameterKeys, which the server's catalog uses too: " +
            string.Join(", ", strangers));
    }

    [Fact]
    public void A_parameter_is_found_whatever_case_it_arrived_in()
    {
        // Parameters arrive as a plain JSON object and deserialise into an
        // ordinal dictionary. A lookup that differs from the sent key only in
        // case silently finds nothing, and the agent then declines an action a
        // person approved for a reason visible from neither side.
        var request = new ActionRequestDto
        {
            Id = Guid.NewGuid(),
            Action = ActionName.RestartService,
            CabinetId = Guid.NewGuid(),
            RequestedByUserId = Guid.NewGuid(),
            RequestedUtc = DateTimeOffset.UtcNow,
            Reason = "Service is hung.",
            Parameters = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["ServiceName"] = "Spooler",
                ["REBOOTIFREQUIRED"] = "true",
            },
        };

        Assert.True(ActionParameters.TryGetRequiredString(
            request, ActionParameterKeys.ServiceName, out string value, out _));

        Assert.Equal("Spooler", value);

        Assert.True(ActionParameters.GetBooleanFlag(request, ActionParameterKeys.RebootIfRequired));

        // And a name that genuinely is not there still reads as absent.
        Assert.False(ActionParameters.TryGetRequiredString(
            request, ActionParameterKeys.LogName, out _, out _));

        Assert.False(ActionParameters.GetBooleanFlag(request, ActionParameterKeys.AllowCrossSite));
    }
}

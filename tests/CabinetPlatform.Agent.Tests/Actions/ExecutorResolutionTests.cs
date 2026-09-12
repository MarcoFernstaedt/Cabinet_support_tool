using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests.Actions;

/// <summary>
/// The agent resolves an executor through a dictionary keyed by
/// <see cref="ActionName"/>, with no default branch and no fallback.
/// </summary>
/// <remarks>
/// <para>
/// This is the property that makes the action catalog the whole of what this
/// product can do to a cabinet. A default branch — anything that says "and
/// otherwise, do this" — would mean an action the catalog does not list could
/// still reach a machine, and the catalog would stop being the complete
/// statement it is relied on to be.
/// </para>
/// <para>
/// The server's half is asserted in its own suite, where the catalog lives.
/// </para>
/// </remarks>
public class ExecutorResolutionTests
{
    [Fact]
    public void An_action_with_no_registered_executor_resolves_to_nothing()
    {
        var registry = new ActionExecutorRegistry(
            Array.Empty<IActionExecutor>(), NullLogger<ActionExecutorRegistry>.Instance);

        foreach (ActionName action in Enum.GetValues<ActionName>())
        {
            Assert.Null(registry.Resolve(action));
        }

        // An integer outside the enum resolves to nothing either. A client can
        // put any number in a JSON body, and a request whose action does not
        // name anything must not fall through to a catch-all.
        Assert.Null(registry.Resolve((ActionName)0));
        Assert.Null(registry.Resolve((ActionName)int.MaxValue));
        Assert.Null(registry.Resolve((ActionName)(-1)));
    }

    [Fact]
    public void Resolution_returns_the_registered_executor_and_only_that_one()
    {
        var stub = new StubExecutor(ActionName.FlushDnsCache);

        var registry = new ActionExecutorRegistry(
            new IActionExecutor[] { stub }, NullLogger<ActionExecutorRegistry>.Instance);

        Assert.Same(stub, registry.Resolve(ActionName.FlushDnsCache));

        // Every other action is still unresolved. Registering one executor does
        // not make the registry answer for its neighbours.
        foreach (ActionName action in Enum.GetValues<ActionName>()
                     .Where(a => a != ActionName.FlushDnsCache))
        {
            Assert.Null(registry.Resolve(action));
        }
    }

    [Fact]
    public void The_registry_has_no_default_or_fallback_branch()
    {
        // Stated over the source rather than the behaviour, because a fallback
        // that is currently unreachable is still a fallback: somebody removes
        // the guard above it and the catalog quietly stops being closed.
        string source = FindSource("ActionExecutorRegistry.cs");

        Assert.DoesNotContain("?? new ", source, StringComparison.Ordinal);
        Assert.DoesNotContain("DefaultExecutor", source, StringComparison.Ordinal);
        Assert.DoesNotContain("FallbackExecutor", source, StringComparison.Ordinal);

        // The resolution itself is a dictionary lookup returning null, not a
        // switch with a default arm.
        Assert.Contains("TryGetValue", source, StringComparison.Ordinal);
        Assert.DoesNotContain("default:", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Every_executor_the_agent_ships_is_registered_and_none_is_orphaned()
    {
        // The other direction. An executor compiled into the agent but never
        // registered is dead code that looks live; one registered twice would
        // mean the registry silently picks a winner. Both are checked against
        // the registration file, because that is where the fact lives.
        string registration = FindSource("AgentServiceRegistration.cs");

        List<Type> executors = typeof(IActionExecutor).Assembly
            .GetTypes()
            .Where(t => t is { IsAbstract: false, IsClass: true, IsNested: false } &&
                        typeof(IActionExecutor).IsAssignableFrom(t))
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .ToList();

        Assert.NotEmpty(executors);

        var unregistered = new List<string>();
        var duplicated = new List<string>();

        foreach (Type executor in executors)
        {
            int registered = Occurrences(registration, $"IActionExecutor, {executor.Name}>");

            if (registered == 0)
            {
                unregistered.Add(executor.Name);
            }
            else if (registered > 1)
            {
                duplicated.Add(executor.Name);
            }
        }

        Assert.True(unregistered.Count == 0,
            "Executors compiled in but never registered, so they can never run: " +
            string.Join(", ", unregistered));

        Assert.True(duplicated.Count == 0,
            "Executors registered more than once: " + string.Join(", ", duplicated));
    }

    private static int Occurrences(string text, string value)
    {
        var count = 0;
        var index = 0;

        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
    }

    private static string FindSource(string fileName)
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);

        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "src")))
        {
            directory = directory.Parent;
        }

        Assert.NotNull(directory);

        string path = Directory
            .EnumerateFiles(Path.Combine(directory!.FullName, "src"), fileName, SearchOption.AllDirectories)
            .Single(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}",
                             StringComparison.Ordinal) &&
                         !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}",
                             StringComparison.Ordinal));

        return File.ReadAllText(path);
    }

    private sealed class StubExecutor : IActionExecutor
    {
        public StubExecutor(ActionName action) => Action = action;

        public ActionName Action { get; }

        public Task<ActionOutcome> ExecuteAsync(
            ActionRequestDto request, CancellationToken cancellationToken) =>
            Task.FromResult(ActionOutcome.Succeeded("stub"));
    }
}

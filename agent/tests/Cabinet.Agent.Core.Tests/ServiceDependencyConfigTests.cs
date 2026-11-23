using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Configuration;
using Xunit;

namespace Cabinet.Agent.Core.Tests;

public sealed class ServiceDependencyConfigTests
{
    private static ServiceInfo Service(IReadOnlyList<string>? dependencies) => new()
    {
        Name = "App", DisplayName = "App", State = ServiceState.Running, StartType = ServiceStartType.Automatic,
        Account = null, ProcessId = null, ExecutablePath = null, Description = null, Recovery = null, Dependencies = dependencies,
    };
    private static ConfigSnapshotCategory Snapshot(IReadOnlyList<string>? dependencies) =>
        ConfigBuilders.Services(new ServicesListOutput { Services = [Service(dependencies)], Watched = [] });

    [Fact]
    public void Dependency_sets_are_case_insensitive_sorted_and_change_the_hash_only_when_membership_changes()
    {
        Assert.Equal(Snapshot(["B", "a", "A"]).Hash, Snapshot(["A", "b"]).Hash);
        Assert.NotEqual(Snapshot(["A"]).Hash, Snapshot(["A", "B"]).Hash);
        Assert.NotEqual(Snapshot(["A"]).Hash, Snapshot([]).Hash);
        Assert.False(Snapshot(null).Items.Single().Values.ContainsKey("dependencies"));
        Assert.True(Snapshot([]).Items.Single().Values.ContainsKey("dependencies"));
    }

    [Fact]
    public void Dependencies_are_never_silently_truncated_or_cleaned_into_different_names()
    {
        Assert.Null(ConfigBuilders.DependencyList(Enumerable.Range(0, 33).Select(i => "Service" + i).ToArray()));
        Assert.Null(ConfigBuilders.DependencyList([new string('x', 201)]));
        Assert.Null(ConfigBuilders.DependencyList(["Bad\nName"]));
        Assert.Equal(new[] { "+group", "app", "missing" }, ConfigBuilders.DependencyList(["Missing", "App", "+Group"]));
    }
}

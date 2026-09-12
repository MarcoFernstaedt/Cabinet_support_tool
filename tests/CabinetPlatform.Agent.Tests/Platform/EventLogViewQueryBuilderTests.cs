using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Tests.Platform;

/// <summary>
/// The agent composes the event log query from a view's named fields.
/// </summary>
/// <remarks>
/// This is the class that makes a saved filter a filter rather than a remote
/// query channel. The server stores logs, sources, event ids, a level and a
/// window; nobody stores or sends an expression. These tests pin that the
/// composition is correct and that the one free-text input — a provider name —
/// cannot change the shape of what is composed.
/// </remarks>
public class EventLogViewQueryBuilderTests
{
    [Fact]
    public void The_level_clause_inverts_windows_numbering()
    {
        // Windows numbers levels the opposite way round from how people think
        // about them: Critical is 1 and Verbose is 5. "At least Warning" is
        // therefore Level <= 3, and getting the comparison backwards would
        // return only the records nobody wanted.
        Assert.Equal("(Level=1)", EventLogViewQueryBuilder.BuildLevelClause(EventLogLevel.Critical));
        Assert.Equal("(Level=1 or Level=2)", EventLogViewQueryBuilder.BuildLevelClause(EventLogLevel.Error));

        Assert.Equal(
            "(Level=1 or Level=2 or Level=3)",
            EventLogViewQueryBuilder.BuildLevelClause(EventLogLevel.Warning));

        Assert.Equal(
            "(Level=1 or Level=2 or Level=3 or Level=4)",
            EventLogViewQueryBuilder.BuildLevelClause(EventLogLevel.Information));
    }

    [Fact]
    public void Verbose_produces_no_level_clause_so_unclassified_records_are_included()
    {
        // Level 0 means the provider did not classify the record, which is what
        // the Security log writes for every audit entry. A clause enumerating
        // 1 to 5 would silently exclude the whole Security log.
        Assert.Null(EventLogViewQueryBuilder.BuildLevelClause(EventLogLevel.Verbose));
    }

    [Fact]
    public void No_sources_and_no_event_ids_produce_no_clauses_rather_than_empty_ones()
    {
        Assert.Null(EventLogViewQueryBuilder.BuildProviderClause(Array.Empty<string>()));
        Assert.Null(EventLogViewQueryBuilder.BuildEventIdClause(Array.Empty<int>()));
    }

    [Fact]
    public void Providers_and_event_ids_become_disjunctions()
    {
        Assert.Equal(
            "Provider[@Name='disk' or @Name='Ntfs']",
            EventLogViewQueryBuilder.BuildProviderClause(new[] { "disk", "Ntfs" }));

        Assert.Equal(
            "(EventID=7 or EventID=51)",
            EventLogViewQueryBuilder.BuildEventIdClause(new[] { 7, 51 }));
    }

    [Theory]
    [InlineData("disk' or @Name='lsass")]
    [InlineData("disk]]]")]
    [InlineData("disk\"")]
    [InlineData("*")]
    [InlineData("")]
    [InlineData("   ")]
    public void A_provider_name_that_could_change_the_expression_is_dropped(string source)
    {
        // Dropped rather than escaped. A provider name has no business
        // containing a quote, the server refuses such a name when the view is
        // written, and dropping it here means a definition that somehow arrived
        // with one still cannot alter the shape of the query.
        Assert.False(EventLogViewQueryBuilder.IsSafeProviderName(source));

        Assert.Null(EventLogViewQueryBuilder.BuildProviderClause(new[] { source }));
    }

    [Theory]
    [InlineData("Microsoft-Windows-WindowsUpdateClient")]
    [InlineData("Service Control Manager")]
    [InlineData(".NET Runtime")]
    [InlineData("storahci")]
    public void The_provider_names_windows_actually_uses_are_accepted(string source)
    {
        Assert.True(EventLogViewQueryBuilder.IsSafeProviderName(source));
    }

    [Fact]
    public void A_whole_view_composes_into_one_system_predicate()
    {
        var definition = new EventLogViewDefinition
        {
            ViewId = Guid.NewGuid(),
            DisplayName = "Disk and storage",
            LogNames = new[] { EventLogName.System },
            Sources = new[] { "disk", "Ntfs" },
            EventIds = new[] { 7, 51 },
            MinimumLevel = EventLogLevel.Warning,
            WindowHours = 24,
            MaximumEntries = 500,
        };

        string xpath = EventLogViewQueryBuilder.Build(definition, TimeSpan.FromHours(24));

        Assert.StartsWith("*[System[", xpath, StringComparison.Ordinal);
        Assert.EndsWith("]]", xpath, StringComparison.Ordinal);

        Assert.Contains("(Level=1 or Level=2 or Level=3)", xpath, StringComparison.Ordinal);
        Assert.Contains("Provider[@Name='disk' or @Name='Ntfs']", xpath, StringComparison.Ordinal);
        Assert.Contains("(EventID=7 or EventID=51)", xpath, StringComparison.Ordinal);

        // timediff takes milliseconds and is evaluated by the event log service
        // against the machine's own clock, which is what makes the window
        // correct on a cabinet whose zone differs from the server's.
        Assert.Contains("timediff(@SystemTime) <= 86400000", xpath, StringComparison.Ordinal);
    }

    [Fact]
    public void An_event_id_outside_the_windows_range_is_dropped()
    {
        Assert.Equal(
            "(EventID=7)",
            EventLogViewQueryBuilder.BuildEventIdClause(new[] { 7, -1, 99999 }));
    }
}

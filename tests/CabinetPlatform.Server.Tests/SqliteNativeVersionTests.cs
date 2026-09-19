using Microsoft.Data.Sqlite;

namespace CabinetPlatform.Server.Tests;

public sealed class SqliteNativeVersionTests
{
    [Fact]
    public async Task Loaded_native_engine_in_disposable_database_meets_security_floor()
    {
        // Synthetic in-memory test storage only, never a cabinet application DB.
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT sqlite_version()";
        var loaded = Version.Parse((string)(await command.ExecuteScalarAsync())!);
        Assert.True(loaded >= new Version(3, 50, 2), $"Loaded SQLite {loaded} is below the CVE-2025-6965 native fix floor 3.50.2.");
    }
}

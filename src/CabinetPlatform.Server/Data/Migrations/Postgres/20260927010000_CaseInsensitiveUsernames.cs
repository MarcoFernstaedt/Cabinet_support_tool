using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Data.Migrations.Postgres;

[DbContext(typeof(PostgresSupportDbContext))]
[Migration("20260927010000_CaseInsensitiveUsernames")]
public sealed class CaseInsensitiveUsernames : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql("CREATE UNIQUE INDEX \"IX_Users_Username_CaseInsensitive\" ON \"Users\" (lower(\"Username\"));");

    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql("DROP INDEX \"IX_Users_Username_CaseInsensitive\";");
}

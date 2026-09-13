using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Data.Migrations.Postgres;

[DbContext(typeof(PostgresSupportDbContext))]
[Migration("20260913201000_SessionContainment")]
public sealed partial class SessionContainment : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.AddColumn<Guid>(name: "SecurityStamp", table: "Users",
            type: "uuid", nullable: false, defaultValue: Guid.Empty);

    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.DropColumn(name: "SecurityStamp", table: "Users");
}

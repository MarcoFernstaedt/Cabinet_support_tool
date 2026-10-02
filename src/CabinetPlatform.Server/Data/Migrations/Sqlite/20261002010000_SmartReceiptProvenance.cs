using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Data.Migrations.Sqlite;

[DbContext(typeof(SqliteSupportDbContext))]
[Migration("20261002010000_SmartReceiptProvenance")]
public sealed class SmartReceiptProvenance : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.AddColumn<DateTimeOffset>(
            name: "ReceivedUtc", table: "SmartReadings", type: "TEXT", nullable: true);

    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql("ALTER TABLE SmartReadings DROP COLUMN ReceivedUtc;");
}

using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace CabinetPlatform.Server.Data.Migrations.Postgres;

[DbContext(typeof(PostgresSupportDbContext))]
[Migration("20261002010000_SmartReceiptProvenance")]
public sealed class SmartReceiptProvenance : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.AddColumn<DateTimeOffset>(
            name: "ReceivedUtc", table: "SmartReadings", type: "timestamp with time zone", nullable: true);

    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.DropColumn(name: "ReceivedUtc", table: "SmartReadings");
}

using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CabinetPlatform.Server.Data.Migrations.Sqlite
{
    /// <inheritdoc />
    public partial class ConnectivityEvidence : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "StatesJson",
                table: "ConnectivityConfigurations",
                type: "TEXT",
                nullable: false,
                defaultValue: "");

            migrationBuilder.CreateTable(
                name: "ConnectivityEvidence",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    SourceCabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    TargetCabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ConfigurationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    FirstObservedUtc = table.Column<string>(type: "TEXT", nullable: false),
                    ObservedUtc = table.Column<string>(type: "TEXT", nullable: false),
                    ReceivedUtc = table.Column<string>(type: "TEXT", nullable: false),
                    SummaryJson = table.Column<string>(type: "TEXT", maxLength: 4096, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ConnectivityEvidence", x => new { x.SourceCabinetId, x.Id });
                    table.ForeignKey(
                        name: "FK_ConnectivityEvidence_Cabinets_SourceCabinetId",
                        column: x => x.SourceCabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ConnectivityEvidence_SourceCabinetId_TargetCabinetId_ObservedUtc",
                table: "ConnectivityEvidence",
                columns: new[] { "SourceCabinetId", "TargetCabinetId", "ObservedUtc" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ConnectivityEvidence");

            migrationBuilder.DropColumn(
                name: "StatesJson",
                table: "ConnectivityConfigurations");
        }
    }
}

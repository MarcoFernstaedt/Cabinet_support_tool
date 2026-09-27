using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CabinetPlatform.Server.Data.Migrations.Postgres
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
                type: "text",
                nullable: false,
                defaultValue: "");

            migrationBuilder.CreateTable(
                name: "ConnectivityEvidence",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SourceCabinetId = table.Column<Guid>(type: "uuid", nullable: false),
                    TargetCabinetId = table.Column<Guid>(type: "uuid", nullable: false),
                    ConfigurationId = table.Column<Guid>(type: "uuid", nullable: false),
                    FirstObservedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ObservedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ReceivedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    SummaryJson = table.Column<string>(type: "character varying(4096)", maxLength: 4096, nullable: false)
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
                name: "IX_ConnectivityEvidence_SourceCabinetId_TargetCabinetId_Observ~",
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

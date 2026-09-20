using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CabinetPlatform.Server.Data.Migrations.Sqlite
{
    /// <inheritdoc />
    public partial class ConnectivityAlerts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ConnectivityAlerts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    SourceCabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    TargetCabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    EvidenceId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ObservedUtc = table.Column<string>(type: "TEXT", nullable: true),
                    ReceivedUtc = table.Column<string>(type: "TEXT", nullable: false),
                    Status = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    Note = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    UpdatedUtc = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ConnectivityAlerts", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ConnectivityAlerts_Cabinets_SourceCabinetId",
                        column: x => x.SourceCabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ConnectivityAlerts_SourceCabinetId_EvidenceId",
                table: "ConnectivityAlerts",
                columns: new[] { "SourceCabinetId", "EvidenceId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ConnectivityAlerts_SourceCabinetId_ReceivedUtc",
                table: "ConnectivityAlerts",
                columns: new[] { "SourceCabinetId", "ReceivedUtc" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ConnectivityAlerts");
        }
    }
}

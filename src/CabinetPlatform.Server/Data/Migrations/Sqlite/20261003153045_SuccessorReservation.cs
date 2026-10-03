using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CabinetPlatform.Server.Data.Migrations.Sqlite
{
    /// <inheritdoc />
    public partial class SuccessorReservation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SuccessorReservations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    PredecessorCabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    SuccessorMachineId = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    ReservedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ReservedUtc = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SuccessorReservations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SuccessorReservations_Cabinets_PredecessorCabinetId",
                        column: x => x.PredecessorCabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SuccessorReservations_PredecessorCabinetId",
                table: "SuccessorReservations",
                column: "PredecessorCabinetId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SuccessorReservations_SuccessorMachineId",
                table: "SuccessorReservations",
                column: "SuccessorMachineId",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SuccessorReservations");
        }
    }
}

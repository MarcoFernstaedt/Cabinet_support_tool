using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CabinetPlatform.Server.Data.Migrations.Sqlite
{
    /// <inheritdoc />
    public partial class SuccessorIssuanceIntent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SuccessorIssuanceIntents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    PredecessorCabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ReservationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    RequestId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ProposedKeyHash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    RequestedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    RequestedUtc = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SuccessorIssuanceIntents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SuccessorIssuanceIntents_Cabinets_PredecessorCabinetId",
                        column: x => x.PredecessorCabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_SuccessorIssuanceIntents_SuccessorReservations_ReservationId",
                        column: x => x.ReservationId,
                        principalTable: "SuccessorReservations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SuccessorIssuanceIntents_PredecessorCabinetId",
                table: "SuccessorIssuanceIntents",
                column: "PredecessorCabinetId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SuccessorIssuanceIntents_RequestId",
                table: "SuccessorIssuanceIntents",
                column: "RequestId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SuccessorIssuanceIntents_ReservationId",
                table: "SuccessorIssuanceIntents",
                column: "ReservationId",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SuccessorIssuanceIntents");
        }
    }
}

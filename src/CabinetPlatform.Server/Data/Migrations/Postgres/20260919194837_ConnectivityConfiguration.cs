using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CabinetPlatform.Server.Data.Migrations.Postgres
{
    /// <inheritdoc />
    public partial class ConnectivityConfiguration : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ConnectivityConfigurations",
                columns: table => new
                {
                    SourceCabinetId = table.Column<Guid>(type: "uuid", nullable: false),
                    ConfigurationId = table.Column<Guid>(type: "uuid", nullable: false),
                    SiteId = table.Column<Guid>(type: "uuid", nullable: false),
                    TargetsJson = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    UpdatedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ConnectivityConfigurations", x => x.SourceCabinetId);
                    table.ForeignKey(
                        name: "FK_ConnectivityConfigurations_Cabinets_SourceCabinetId",
                        column: x => x.SourceCabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ConnectivityConfigurations");
        }
    }
}

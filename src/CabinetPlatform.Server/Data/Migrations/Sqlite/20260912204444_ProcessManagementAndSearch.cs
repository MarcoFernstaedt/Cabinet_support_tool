using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CabinetPlatform.Server.Data.Migrations.Sqlite
{
    /// <inheritdoc />
    public partial class ProcessManagementAndSearch : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "HasHardwareActuation",
                table: "Users",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "AutoStartServicesStoppedCount",
                table: "Cabinets",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "PendingSecurityUpdateCount",
                table: "Cabinets",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "OnSiteConfirmedByUserId",
                table: "ActionRequests",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OnSiteConfirmedUtc",
                table: "ActionRequests",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "EventLogViews",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    DisplayName = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    Description = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true),
                    LogNamesJson = table.Column<string>(type: "TEXT", nullable: false),
                    SourcesJson = table.Column<string>(type: "TEXT", nullable: false),
                    EventIdsJson = table.Column<string>(type: "TEXT", nullable: false),
                    MinimumLevel = table.Column<int>(type: "INTEGER", nullable: false),
                    DefaultWindowHours = table.Column<int>(type: "INTEGER", nullable: false),
                    MaximumEntries = table.Column<int>(type: "INTEGER", nullable: false),
                    IsSeeded = table.Column<bool>(type: "INTEGER", nullable: false),
                    IsRetired = table.Column<bool>(type: "INTEGER", nullable: false),
                    CreatedUtc = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    UpdatedUtc = table.Column<string>(type: "TEXT", nullable: true),
                    UpdatedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "BLOB", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_EventLogViews", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "RecentCabinetViews",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    CabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    LastViewedUtc = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RecentCabinetViews", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RecentCabinetViews_Cabinets_CabinetId",
                        column: x => x.CabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_AutoStartServicesStoppedCount",
                table: "Cabinets",
                column: "AutoStartServicesStoppedCount");

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_DepartmentName",
                table: "Cabinets",
                column: "DepartmentName");

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_Hostname",
                table: "Cabinets",
                column: "Hostname");

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_PendingSecurityUpdateCount",
                table: "Cabinets",
                column: "PendingSecurityUpdateCount");

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_SerialNumber",
                table: "Cabinets",
                column: "SerialNumber");

            migrationBuilder.CreateIndex(
                name: "IX_EventLogViews_DisplayName",
                table: "EventLogViews",
                column: "DisplayName",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_EventLogViews_IsRetired",
                table: "EventLogViews",
                column: "IsRetired");

            migrationBuilder.CreateIndex(
                name: "IX_RecentCabinetViews_CabinetId",
                table: "RecentCabinetViews",
                column: "CabinetId");

            migrationBuilder.CreateIndex(
                name: "IX_RecentCabinetViews_UserId_CabinetId",
                table: "RecentCabinetViews",
                columns: new[] { "UserId", "CabinetId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_RecentCabinetViews_UserId_LastViewedUtc_Desc",
                table: "RecentCabinetViews",
                columns: new[] { "UserId", "LastViewedUtc" },
                descending: new[] { false, true });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "EventLogViews");

            migrationBuilder.DropTable(
                name: "RecentCabinetViews");

            migrationBuilder.DropIndex(
                name: "IX_Cabinets_AutoStartServicesStoppedCount",
                table: "Cabinets");

            migrationBuilder.DropIndex(
                name: "IX_Cabinets_DepartmentName",
                table: "Cabinets");

            migrationBuilder.DropIndex(
                name: "IX_Cabinets_Hostname",
                table: "Cabinets");

            migrationBuilder.DropIndex(
                name: "IX_Cabinets_PendingSecurityUpdateCount",
                table: "Cabinets");

            migrationBuilder.DropIndex(
                name: "IX_Cabinets_SerialNumber",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "HasHardwareActuation",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "AutoStartServicesStoppedCount",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "PendingSecurityUpdateCount",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "OnSiteConfirmedByUserId",
                table: "ActionRequests");

            migrationBuilder.DropColumn(
                name: "OnSiteConfirmedUtc",
                table: "ActionRequests");
        }
    }
}

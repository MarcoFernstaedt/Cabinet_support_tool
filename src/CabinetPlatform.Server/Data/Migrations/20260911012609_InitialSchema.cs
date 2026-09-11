using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CabinetPlatform.Server.Data.Migrations
{
    /// <inheritdoc />
    public partial class InitialSchema : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AuditEntries",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    TimestampUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    ActorType = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                    ActorId = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    ActorDisplayName = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    EventKind = table.Column<int>(type: "INTEGER", nullable: false),
                    Action = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    CabinetId = table.Column<Guid>(type: "TEXT", nullable: true),
                    CabinetHostname = table.Column<string>(type: "TEXT", maxLength: 255, nullable: true),
                    Result = table.Column<int>(type: "INTEGER", nullable: false),
                    Reason = table.Column<string>(type: "TEXT", maxLength: 2000, nullable: true),
                    TicketReference = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    ApprovedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    Details = table.Column<string>(type: "TEXT", nullable: true),
                    CorrelationId = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    RemoteIpAddress = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AuditEntries", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Cabinets",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    MachineId = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    Hostname = table.Column<string>(type: "TEXT", maxLength: 255, nullable: false),
                    ClientName = table.Column<string>(type: "TEXT", maxLength: 255, nullable: false),
                    SiteName = table.Column<string>(type: "TEXT", maxLength: 255, nullable: false),
                    DepartmentName = table.Column<string>(type: "TEXT", maxLength: 255, nullable: true),
                    Model = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    SerialNumber = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    ApprovedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    ApprovedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    IsActive = table.Column<bool>(type: "INTEGER", nullable: false),
                    LastCheckInUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    AgentVersion = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Cabinets", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "PendingRegistrations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    MachineId = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    Hostname = table.Column<string>(type: "TEXT", maxLength: 255, nullable: false),
                    OsVersion = table.Column<string>(type: "TEXT", maxLength: 255, nullable: true),
                    AgentVersion = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    FirstSeenUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    LastSeenUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    DecidedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    DecidedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PendingRegistrations", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Users",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Username = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    PasswordHash = table.Column<byte[]>(type: "BLOB", nullable: false),
                    PasswordSalt = table.Column<byte[]>(type: "BLOB", nullable: false),
                    PasswordIterations = table.Column<int>(type: "INTEGER", nullable: false),
                    DisplayName = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    Role = table.Column<int>(type: "INTEGER", nullable: false),
                    HasElevatedSql = table.Column<bool>(type: "INTEGER", nullable: false),
                    IsActive = table.Column<bool>(type: "INTEGER", nullable: false),
                    MustChangePassword = table.Column<bool>(type: "INTEGER", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    LastLoginUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    FailedLoginCount = table.Column<int>(type: "INTEGER", nullable: false),
                    LockedUntilUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Users", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ActionRequests",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Action = table.Column<int>(type: "INTEGER", nullable: false),
                    CabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    RequestedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    RequestedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    ParametersJson = table.Column<string>(type: "TEXT", nullable: false),
                    Reason = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: false),
                    TicketReference = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    ApprovedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    ApprovedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    DispatchedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    CompletedUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    ResultStatus = table.Column<int>(type: "INTEGER", nullable: true),
                    ResultOutput = table.Column<string>(type: "TEXT", maxLength: 8000, nullable: true),
                    ExpiresUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    SafetyChecksOverridden = table.Column<bool>(type: "INTEGER", nullable: false),
                    OverrideReason = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ActionRequests", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ActionRequests_Cabinets_CabinetId",
                        column: x => x.CabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "CheckIns",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    CabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ReceivedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    CollectedAtUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    PayloadJson = table.Column<string>(type: "TEXT", nullable: false),
                    CpuPercent = table.Column<double>(type: "REAL", nullable: false),
                    RamUsedPercent = table.Column<double>(type: "REAL", nullable: false),
                    MinFreeDiskPercent = table.Column<double>(type: "REAL", nullable: false),
                    PendingUpdateCount = table.Column<int>(type: "INTEGER", nullable: false),
                    WorstDiskHealth = table.Column<int>(type: "INTEGER", nullable: false),
                    AnyUserLoggedOn = table.Column<bool>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CheckIns", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CheckIns_Cabinets_CabinetId",
                        column: x => x.CabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "SmartReadings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    CabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    DriveSerial = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    DriveModel = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    FirmwareVersion = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    DeviceId = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    TimestampUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    PredictedHealth = table.Column<int>(type: "INTEGER", nullable: false),
                    IsAggregated = table.Column<bool>(type: "INTEGER", nullable: false),
                    SampleCount = table.Column<int>(type: "INTEGER", nullable: false),
                    ReallocatedSectorCount = table.Column<long>(type: "INTEGER", nullable: true),
                    ReportedUncorrectableErrors = table.Column<long>(type: "INTEGER", nullable: true),
                    CommandTimeoutCount = table.Column<long>(type: "INTEGER", nullable: true),
                    CurrentPendingSectorCount = table.Column<long>(type: "INTEGER", nullable: true),
                    OfflineUncorrectableCount = table.Column<long>(type: "INTEGER", nullable: true),
                    UdmaCrcErrorCount = table.Column<long>(type: "INTEGER", nullable: true),
                    SpinRetryCount = table.Column<long>(type: "INTEGER", nullable: true),
                    SeekErrorRate = table.Column<long>(type: "INTEGER", nullable: true),
                    ReadErrorRate = table.Column<long>(type: "INTEGER", nullable: true),
                    WearLevelingCount = table.Column<long>(type: "INTEGER", nullable: true),
                    PercentageUsed = table.Column<int>(type: "INTEGER", nullable: true),
                    AvailableSparePercent = table.Column<int>(type: "INTEGER", nullable: true),
                    AvailableSpareThresholdPercent = table.Column<int>(type: "INTEGER", nullable: true),
                    MediaAndDataIntegrityErrors = table.Column<long>(type: "INTEGER", nullable: true),
                    UnsafeShutdownCount = table.Column<long>(type: "INTEGER", nullable: true),
                    PowerOnHours = table.Column<long>(type: "INTEGER", nullable: true),
                    PowerCycleCount = table.Column<long>(type: "INTEGER", nullable: true),
                    TemperatureCelsius = table.Column<int>(type: "INTEGER", nullable: true),
                    TotalHostReadsGb = table.Column<long>(type: "INTEGER", nullable: true),
                    TotalHostWritesGb = table.Column<long>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SmartReadings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SmartReadings_Cabinets_CabinetId",
                        column: x => x.CabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ActionRequests_CabinetId_Status",
                table: "ActionRequests",
                columns: new[] { "CabinetId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_ActionRequests_ExpiresUtc",
                table: "ActionRequests",
                column: "ExpiresUtc");

            migrationBuilder.CreateIndex(
                name: "IX_ActionRequests_RequestedByUserId",
                table: "ActionRequests",
                column: "RequestedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_ActionRequests_Status",
                table: "ActionRequests",
                column: "Status");

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_ActorId",
                table: "AuditEntries",
                column: "ActorId");

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_CabinetId",
                table: "AuditEntries",
                column: "CabinetId");

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_CabinetId_TimestampUtc",
                table: "AuditEntries",
                columns: new[] { "CabinetId", "TimestampUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_EventKind",
                table: "AuditEntries",
                column: "EventKind");

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_Result",
                table: "AuditEntries",
                column: "Result");

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_TimestampUtc",
                table: "AuditEntries",
                column: "TimestampUtc");

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_ClientName_SiteName",
                table: "Cabinets",
                columns: new[] { "ClientName", "SiteName" });

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_IsActive",
                table: "Cabinets",
                column: "IsActive");

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_LastCheckInUtc",
                table: "Cabinets",
                column: "LastCheckInUtc");

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_MachineId",
                table: "Cabinets",
                column: "MachineId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_CheckIns_CabinetId_CollectedAtUtc",
                table: "CheckIns",
                columns: new[] { "CabinetId", "CollectedAtUtc" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_CheckIns_CabinetId_ReceivedUtc_Desc",
                table: "CheckIns",
                columns: new[] { "CabinetId", "ReceivedUtc" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "IX_CheckIns_ReceivedUtc",
                table: "CheckIns",
                column: "ReceivedUtc");

            migrationBuilder.CreateIndex(
                name: "IX_PendingRegistrations_MachineId",
                table: "PendingRegistrations",
                column: "MachineId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_PendingRegistrations_Status",
                table: "PendingRegistrations",
                column: "Status");

            migrationBuilder.CreateIndex(
                name: "IX_SmartReadings_Cabinet_Drive_Timestamp",
                table: "SmartReadings",
                columns: new[] { "CabinetId", "DriveSerial", "TimestampUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_SmartReadings_TimestampUtc",
                table: "SmartReadings",
                column: "TimestampUtc");

            migrationBuilder.CreateIndex(
                name: "IX_Users_IsActive",
                table: "Users",
                column: "IsActive");

            migrationBuilder.CreateIndex(
                name: "IX_Users_Username",
                table: "Users",
                column: "Username",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ActionRequests");

            migrationBuilder.DropTable(
                name: "AuditEntries");

            migrationBuilder.DropTable(
                name: "CheckIns");

            migrationBuilder.DropTable(
                name: "PendingRegistrations");

            migrationBuilder.DropTable(
                name: "SmartReadings");

            migrationBuilder.DropTable(
                name: "Users");

            migrationBuilder.DropTable(
                name: "Cabinets");
        }
    }
}

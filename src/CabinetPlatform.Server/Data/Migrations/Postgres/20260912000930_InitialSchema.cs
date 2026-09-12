using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CabinetPlatform.Server.Data.Migrations.Postgres
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
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TimestampUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ActorType = table.Column<int>(type: "integer", nullable: false),
                    ActorId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    ActorDisplayName = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    EventKind = table.Column<int>(type: "integer", nullable: false),
                    Event = table.Column<int>(type: "integer", nullable: false),
                    Action = table.Column<int>(type: "integer", nullable: true),
                    CabinetId = table.Column<Guid>(type: "uuid", nullable: true),
                    CabinetHostname = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    TargetCabinetId = table.Column<Guid>(type: "uuid", nullable: true),
                    TargetCabinetHostname = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    Result = table.Column<int>(type: "integer", nullable: false),
                    Reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    TicketReference = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    BatchId = table.Column<Guid>(type: "uuid", nullable: true),
                    ApprovedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    Details = table.Column<string>(type: "text", nullable: true),
                    CorrelationId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    RemoteIpAddress = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AuditEntries", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "BatchActionRequests",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Action = table.Column<int>(type: "integer", nullable: false),
                    ParametersJson = table.Column<string>(type: "text", nullable: false),
                    RequestedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    RequestedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Reason = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    TicketReference = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    ApprovedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    ApprovedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    DenialReason = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    TargetCount = table.Column<int>(type: "integer", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "bytea", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BatchActionRequests", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "CabinetLinkProbes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SourceCabinetId = table.Column<Guid>(type: "uuid", nullable: false),
                    TargetCabinetId = table.Column<Guid>(type: "uuid", nullable: false),
                    ObservedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Reachable = table.Column<bool>(type: "boolean", nullable: false),
                    LatencyMs = table.Column<double>(type: "double precision", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CabinetLinkProbes", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Clients",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Clients", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "PendingRegistrations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    MachineId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Hostname = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    OsVersion = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    AgentVersion = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    FirstSeenUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastSeenUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    DecidedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    DecidedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PendingRegistrations", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Users",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Username = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    PasswordHash = table.Column<byte[]>(type: "bytea", nullable: false),
                    PasswordSalt = table.Column<byte[]>(type: "bytea", nullable: false),
                    PasswordIterations = table.Column<int>(type: "integer", nullable: false),
                    DisplayName = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Role = table.Column<int>(type: "integer", nullable: false),
                    HasElevatedSql = table.Column<bool>(type: "boolean", nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    MustChangePassword = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    LastLoginUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    FailedLoginCount = table.Column<int>(type: "integer", nullable: false),
                    LockedUntilUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "bytea", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Users", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "RefreshTokens",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ChainId = table.Column<Guid>(type: "uuid", nullable: false),
                    TokenHash = table.Column<byte[]>(type: "bytea", nullable: false),
                    IssuedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ConsumedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RevokedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RevokedReason = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    ReplacedByTokenId = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RefreshTokens", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RefreshTokens_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ActionRequests",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Action = table.Column<int>(type: "integer", nullable: false),
                    CabinetId = table.Column<Guid>(type: "uuid", nullable: false),
                    TargetCabinetId = table.Column<Guid>(type: "uuid", nullable: true),
                    IsCrossSiteTarget = table.Column<bool>(type: "boolean", nullable: false),
                    BatchId = table.Column<Guid>(type: "uuid", nullable: true),
                    RequestedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    RequestedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ParametersJson = table.Column<string>(type: "text", nullable: false),
                    Reason = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    TicketReference = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    ApprovedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    ApprovedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    DispatchedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CompletedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ResultStatus = table.Column<int>(type: "integer", nullable: true),
                    ResultOutput = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: true),
                    ExitCode = table.Column<int>(type: "integer", nullable: true),
                    StartedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CollectedDataJson = table.Column<string>(type: "text", nullable: true),
                    ExpiresUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    SafetyChecksOverridden = table.Column<bool>(type: "boolean", nullable: false),
                    OverrideReason = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "bytea", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ActionRequests", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "BatchActionTargets",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    BatchId = table.Column<Guid>(type: "uuid", nullable: false),
                    CabinetId = table.Column<Guid>(type: "uuid", nullable: false),
                    ActionRequestId = table.Column<Guid>(type: "uuid", nullable: true),
                    SkippedReason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BatchActionTargets", x => x.Id);
                    table.ForeignKey(
                        name: "FK_BatchActionTargets_BatchActionRequests_BatchId",
                        column: x => x.BatchId,
                        principalTable: "BatchActionRequests",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Cabinets",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    MachineId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Hostname = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    SiteId = table.Column<Guid>(type: "uuid", nullable: false),
                    DepartmentName = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    Role = table.Column<int>(type: "integer", nullable: false),
                    Model = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    SerialNumber = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    TimeZoneId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    LastKnownIpAddress = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ApprovedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ApprovedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    LastCheckInUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastFullCheckInUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    AgentVersion = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    CurrentInventoryVersionId = table.Column<Guid>(type: "uuid", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "bytea", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Cabinets", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Heartbeats",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CabinetId = table.Column<Guid>(type: "uuid", nullable: false),
                    ReceivedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    CollectedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    AgentVersion = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    UptimeSeconds = table.Column<double>(type: "double precision", nullable: true),
                    CpuPercent = table.Column<double>(type: "double precision", nullable: true),
                    RamUsedPercent = table.Column<double>(type: "double precision", nullable: true),
                    MinFreeDiskPercent = table.Column<double>(type: "double precision", nullable: true),
                    WorstDiskHealth = table.Column<int>(type: "integer", nullable: false),
                    AnyUserLoggedOn = table.Column<bool>(type: "boolean", nullable: true),
                    PendingUpdateCount = table.Column<int>(type: "integer", nullable: true),
                    RebootPending = table.Column<bool>(type: "boolean", nullable: true),
                    ClockDriftSeconds = table.Column<double>(type: "double precision", nullable: true),
                    SectionErrorsJson = table.Column<string>(type: "text", nullable: false),
                    IsAggregated = table.Column<bool>(type: "boolean", nullable: false),
                    SampleCount = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Heartbeats", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Heartbeats_Cabinets_CabinetId",
                        column: x => x.CabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "InventoryVersions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CabinetId = table.Column<Guid>(type: "uuid", nullable: false),
                    ContentHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    FirstObservedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastObservedUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    PayloadJson = table.Column<string>(type: "text", nullable: false),
                    SectionErrorsJson = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InventoryVersions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_InventoryVersions_Cabinets_CabinetId",
                        column: x => x.CabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Sites",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ClientId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    SyncCabinetId = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Sites", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Sites_Cabinets_SyncCabinetId",
                        column: x => x.SyncCabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_Sites_Clients_ClientId",
                        column: x => x.ClientId,
                        principalTable: "Clients",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "SmartReadings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CabinetId = table.Column<Guid>(type: "uuid", nullable: false),
                    DriveSerial = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    DriveModel = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    TimestampUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Health = table.Column<int>(type: "integer", nullable: false),
                    Source = table.Column<int>(type: "integer", nullable: false),
                    ReallocatedSectorCount = table.Column<int>(type: "integer", nullable: true),
                    PendingSectorCount = table.Column<int>(type: "integer", nullable: true),
                    UncorrectableErrorCount = table.Column<int>(type: "integer", nullable: true),
                    PowerOnHours = table.Column<int>(type: "integer", nullable: true),
                    TemperatureCelsius = table.Column<int>(type: "integer", nullable: true),
                    OverallPredictFailure = table.Column<bool>(type: "boolean", nullable: true),
                    PredictFailureReason = table.Column<int>(type: "integer", nullable: true),
                    Wear = table.Column<int>(type: "integer", nullable: true),
                    ReadErrorsTotal = table.Column<long>(type: "bigint", nullable: true),
                    ReadErrorsUncorrected = table.Column<long>(type: "bigint", nullable: true),
                    WriteErrorsTotal = table.Column<long>(type: "bigint", nullable: true),
                    WriteErrorsUncorrected = table.Column<long>(type: "bigint", nullable: true),
                    TemperatureMax = table.Column<int>(type: "integer", nullable: true),
                    StartStopCycleCount = table.Column<int>(type: "integer", nullable: true),
                    IsAggregated = table.Column<bool>(type: "boolean", nullable: false)
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
                name: "IX_ActionRequests_BatchId",
                table: "ActionRequests",
                column: "BatchId");

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
                name: "IX_AuditEntries_BatchId",
                table: "AuditEntries",
                column: "BatchId");

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_CabinetId",
                table: "AuditEntries",
                column: "CabinetId");

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_CabinetId_TimestampUtc",
                table: "AuditEntries",
                columns: new[] { "CabinetId", "TimestampUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_Event",
                table: "AuditEntries",
                column: "Event");

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
                name: "IX_BatchActionRequests_RequestedByUserId",
                table: "BatchActionRequests",
                column: "RequestedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_BatchActionRequests_Status",
                table: "BatchActionRequests",
                column: "Status");

            migrationBuilder.CreateIndex(
                name: "IX_BatchActionTargets_BatchId_CabinetId",
                table: "BatchActionTargets",
                columns: new[] { "BatchId", "CabinetId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_BatchActionTargets_CabinetId",
                table: "BatchActionTargets",
                column: "CabinetId");

            migrationBuilder.CreateIndex(
                name: "IX_CabinetLinkProbes_SourceCabinetId_TargetCabinetId",
                table: "CabinetLinkProbes",
                columns: new[] { "SourceCabinetId", "TargetCabinetId" },
                unique: true);

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
                name: "IX_Cabinets_Role",
                table: "Cabinets",
                column: "Role");

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_SiteId",
                table: "Cabinets",
                column: "SiteId");

            migrationBuilder.CreateIndex(
                name: "IX_Clients_Name",
                table: "Clients",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Heartbeats_CabinetId_CollectedAtUtc",
                table: "Heartbeats",
                columns: new[] { "CabinetId", "CollectedAtUtc" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Heartbeats_CabinetId_ReceivedUtc_Desc",
                table: "Heartbeats",
                columns: new[] { "CabinetId", "ReceivedUtc" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "IX_Heartbeats_ReceivedUtc",
                table: "Heartbeats",
                column: "ReceivedUtc");

            migrationBuilder.CreateIndex(
                name: "IX_InventoryVersions_CabinetId_ContentHash",
                table: "InventoryVersions",
                columns: new[] { "CabinetId", "ContentHash" });

            migrationBuilder.CreateIndex(
                name: "IX_InventoryVersions_CabinetId_LastObservedUtc_Desc",
                table: "InventoryVersions",
                columns: new[] { "CabinetId", "LastObservedUtc" },
                descending: new[] { false, true });

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
                name: "IX_RefreshTokens_ChainId",
                table: "RefreshTokens",
                column: "ChainId");

            migrationBuilder.CreateIndex(
                name: "IX_RefreshTokens_TokenHash",
                table: "RefreshTokens",
                column: "TokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_RefreshTokens_UserId_ExpiresUtc",
                table: "RefreshTokens",
                columns: new[] { "UserId", "ExpiresUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_Sites_ClientId_Name",
                table: "Sites",
                columns: new[] { "ClientId", "Name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Sites_SyncCabinetId",
                table: "Sites",
                column: "SyncCabinetId");

            migrationBuilder.CreateIndex(
                name: "IX_SmartReadings_Cabinet_Drive_Timestamp_Desc",
                table: "SmartReadings",
                columns: new[] { "CabinetId", "DriveSerial", "TimestampUtc" },
                descending: new[] { false, false, true });

            migrationBuilder.CreateIndex(
                name: "IX_SmartReadings_CabinetId_TimestampUtc_Desc",
                table: "SmartReadings",
                columns: new[] { "CabinetId", "TimestampUtc" },
                descending: new[] { false, true });

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

            migrationBuilder.AddForeignKey(
                name: "FK_ActionRequests_Cabinets_CabinetId",
                table: "ActionRequests",
                column: "CabinetId",
                principalTable: "Cabinets",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_BatchActionTargets_Cabinets_CabinetId",
                table: "BatchActionTargets",
                column: "CabinetId",
                principalTable: "Cabinets",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_Cabinets_Sites_SiteId",
                table: "Cabinets",
                column: "SiteId",
                principalTable: "Sites",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Sites_Cabinets_SyncCabinetId",
                table: "Sites");

            migrationBuilder.DropTable(
                name: "ActionRequests");

            migrationBuilder.DropTable(
                name: "AuditEntries");

            migrationBuilder.DropTable(
                name: "BatchActionTargets");

            migrationBuilder.DropTable(
                name: "CabinetLinkProbes");

            migrationBuilder.DropTable(
                name: "Heartbeats");

            migrationBuilder.DropTable(
                name: "InventoryVersions");

            migrationBuilder.DropTable(
                name: "PendingRegistrations");

            migrationBuilder.DropTable(
                name: "RefreshTokens");

            migrationBuilder.DropTable(
                name: "SmartReadings");

            migrationBuilder.DropTable(
                name: "BatchActionRequests");

            migrationBuilder.DropTable(
                name: "Users");

            migrationBuilder.DropTable(
                name: "Cabinets");

            migrationBuilder.DropTable(
                name: "Sites");

            migrationBuilder.DropTable(
                name: "Clients");
        }
    }
}

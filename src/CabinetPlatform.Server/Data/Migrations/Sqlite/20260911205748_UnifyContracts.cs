using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CabinetPlatform.Server.Data.Migrations.Sqlite
{
    /// <inheritdoc />
    public partial class UnifyContracts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {

            // ----------------------------------------------------------------
            // Value remaps, before any column changes type.
            //
            // The merge adopted session 1's numbering for every shared enum.
            // Several of those numbers differ from the ones session 3's server
            // wrote, and every enum in this model is persisted as an integer,
            // so the code change alone would silently reinterpret existing
            // rows. Each statement below is a straight substitution, written
            // as ANSI SQL so it runs identically on SQLite and PostgreSQL.
            //
            // No database with rows is known to exist yet. These run anyway,
            // because "there is no data" is a claim about today.
            // ----------------------------------------------------------------

            // AuditResult: session 3 had Denied = 2, Failure = 3. Session 1 has
            // Failure = 2, Denied = 3. Without this swap every refusal in the
            // trail would read as a failure and every failure as a refusal —
            // the two things a compliance reviewer most needs told apart.
            migrationBuilder.Sql(
                "UPDATE AuditEntries SET Result = CASE Result WHEN 2 THEN 3 WHEN 3 THEN 2 ELSE Result END;");

            // ActorType moves from text to an enum. The values are rewritten
            // while the column is still text, so the type change that follows
            // has only numerals to convert.
            migrationBuilder.Sql(
                "UPDATE AuditEntries SET ActorType = CASE ActorType " +
                "WHEN 'User' THEN '1' WHEN 'Agent' THEN '2' " +
                "WHEN 'System' THEN '3' WHEN 'Anonymous' THEN '4' ELSE '3' END;");

            // ActionRequest.Action: session 3's CabinetActionType numbered the
            // same nine names differently. Seven of the nine move.
            migrationBuilder.Sql(
                "UPDATE ActionRequests SET Action = CASE Action " +
                "WHEN 2 THEN 3 WHEN 3 THEN 4 WHEN 4 THEN 5 WHEN 5 THEN 6 " +
                "WHEN 6 THEN 7 WHEN 7 THEN 8 WHEN 8 THEN 2 ELSE Action END;");

            // ActionResultStatus -> ActionStatus: session 3's TimedOut = 3 and
            // Refused = 4 become TimedOut = 4 and Denied = 3.
            migrationBuilder.Sql(
                "UPDATE ActionRequests SET ResultStatus = CASE ResultStatus " +
                "WHEN 3 THEN 4 WHEN 4 THEN 3 ELSE ResultStatus END;");

            // DiskHealthStatus loses its fifth level: session 3's Failed = 4
            // folds into Failing = 3, and Warning/Critical keep their numbers
            // as Watch/Failing.
            migrationBuilder.Sql(
                "UPDATE SmartReadings SET PredictedHealth = 3 WHERE PredictedHealth = 4;");
            migrationBuilder.Sql(
                "UPDATE CheckIns SET WorstDiskHealth = 3 WHERE WorstDiskHealth = 4;");
            migrationBuilder.DropIndex(
                name: "IX_SmartReadings_Cabinet_Drive_Timestamp",
                table: "SmartReadings");

            migrationBuilder.DropIndex(
                name: "IX_Cabinets_ClientName_SiteName",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "AvailableSparePercent",
                table: "SmartReadings");

            migrationBuilder.DropColumn(
                name: "AvailableSpareThresholdPercent",
                table: "SmartReadings");

            migrationBuilder.DropColumn(
                name: "CommandTimeoutCount",
                table: "SmartReadings");

            migrationBuilder.DropColumn(
                name: "DeviceId",
                table: "SmartReadings");

            migrationBuilder.DropColumn(
                name: "FirmwareVersion",
                table: "SmartReadings");

            migrationBuilder.DropColumn(
                name: "MediaAndDataIntegrityErrors",
                table: "SmartReadings");

            migrationBuilder.DropColumn(
                name: "OfflineUncorrectableCount",
                table: "SmartReadings");

            migrationBuilder.RenameColumn(
                name: "PredictedHealth",
                table: "SmartReadings",
                newName: "Health");

            migrationBuilder.AddColumn<byte[]>(
                name: "RowVersion",
                table: "Users",
                type: "BLOB",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "CurrentInventoryVersionId",
                table: "Cabinets",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "LastFullCheckInUtc",
                table: "Cabinets",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastKnownIpAddress",
                table: "Cabinets",
                type: "TEXT",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Role",
                table: "Cabinets",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<byte[]>(
                name: "RowVersion",
                table: "Cabinets",
                type: "BLOB",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "SiteId",
                table: "Cabinets",
                type: "TEXT",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"));

            migrationBuilder.AddColumn<string>(
                name: "TimeZoneId",
                table: "Cabinets",
                type: "TEXT",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AlterColumn<int>(
                name: "ActorType",
                table: "AuditEntries",
                type: "INTEGER",
                nullable: false,
                oldClrType: typeof(string),
                oldType: "TEXT",
                oldMaxLength: 32);

            migrationBuilder.AlterColumn<int>(
                name: "Action",
                table: "AuditEntries",
                type: "INTEGER",
                nullable: true,
                oldClrType: typeof(string),
                oldType: "TEXT",
                oldMaxLength: 128);

            migrationBuilder.AddColumn<Guid>(
                name: "BatchId",
                table: "AuditEntries",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Event",
                table: "AuditEntries",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "TargetCabinetHostname",
                table: "AuditEntries",
                type: "TEXT",
                maxLength: 255,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "TargetCabinetId",
                table: "AuditEntries",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "BatchId",
                table: "ActionRequests",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "CollectedDataJson",
                table: "ActionRequests",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ExitCode",
                table: "ActionRequests",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "IsCrossSiteTarget",
                table: "ActionRequests",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<byte[]>(
                name: "RowVersion",
                table: "ActionRequests",
                type: "BLOB",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "StartedUtc",
                table: "ActionRequests",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "TargetCabinetId",
                table: "ActionRequests",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "BatchActionRequests",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Action = table.Column<int>(type: "INTEGER", nullable: false),
                    ParametersJson = table.Column<string>(type: "TEXT", nullable: false),
                    RequestedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    RequestedUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    Reason = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: false),
                    TicketReference = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    ApprovedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    ApprovedUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: true),
                    DenialReason = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true),
                    TargetCount = table.Column<int>(type: "INTEGER", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "BLOB", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BatchActionRequests", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "CabinetLinkProbes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    SourceCabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    TargetCabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ObservedUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    Reachable = table.Column<bool>(type: "INTEGER", nullable: false),
                    LatencyMs = table.Column<double>(type: "REAL", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CabinetLinkProbes", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Clients",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", maxLength: 255, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Clients", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Heartbeats",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    CabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ReceivedUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    CollectedAtUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    AgentVersion = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    UptimeSeconds = table.Column<double>(type: "REAL", nullable: true),
                    CpuPercent = table.Column<double>(type: "REAL", nullable: true),
                    RamUsedPercent = table.Column<double>(type: "REAL", nullable: true),
                    MinFreeDiskPercent = table.Column<double>(type: "REAL", nullable: true),
                    WorstDiskHealth = table.Column<int>(type: "INTEGER", nullable: false),
                    AnyUserLoggedOn = table.Column<bool>(type: "INTEGER", nullable: true),
                    PendingUpdateCount = table.Column<int>(type: "INTEGER", nullable: true),
                    RebootPending = table.Column<bool>(type: "INTEGER", nullable: true),
                    ClockDriftSeconds = table.Column<double>(type: "REAL", nullable: true),
                    SectionErrorsJson = table.Column<string>(type: "TEXT", nullable: false),
                    IsAggregated = table.Column<bool>(type: "INTEGER", nullable: false),
                    SampleCount = table.Column<int>(type: "INTEGER", nullable: false)
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
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    CabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ContentHash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    FirstObservedUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    LastObservedUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    PayloadJson = table.Column<string>(type: "TEXT", nullable: false),
                    SectionErrorsJson = table.Column<string>(type: "TEXT", nullable: false)
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
                name: "RefreshTokens",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ChainId = table.Column<Guid>(type: "TEXT", nullable: false),
                    TokenHash = table.Column<byte[]>(type: "BLOB", nullable: false),
                    IssuedUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    ExpiresUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    ConsumedUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: true),
                    RevokedUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: true),
                    RevokedReason = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true),
                    ReplacedByTokenId = table.Column<Guid>(type: "TEXT", nullable: true)
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
                name: "BatchActionTargets",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    BatchId = table.Column<Guid>(type: "TEXT", nullable: false),
                    CabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ActionRequestId = table.Column<Guid>(type: "TEXT", nullable: true),
                    SkippedReason = table.Column<string>(type: "TEXT", maxLength: 500, nullable: true)
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
                    table.ForeignKey(
                        name: "FK_BatchActionTargets_Cabinets_CabinetId",
                        column: x => x.CabinetId,
                        principalTable: "Cabinets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Sites",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    ClientId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", maxLength: 255, nullable: false),
                    SyncCabinetId = table.Column<Guid>(type: "TEXT", nullable: true)
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
                name: "IX_Cabinets_Role",
                table: "Cabinets",
                column: "Role");

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_SiteId",
                table: "Cabinets",
                column: "SiteId");

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_BatchId",
                table: "AuditEntries",
                column: "BatchId");

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_Event",
                table: "AuditEntries",
                column: "Event");

            migrationBuilder.CreateIndex(
                name: "IX_ActionRequests_BatchId",
                table: "ActionRequests",
                column: "BatchId");

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

            migrationBuilder.AddForeignKey(
                name: "FK_Cabinets_Sites_SiteId",
                table: "Cabinets",
                column: "SiteId",
                principalTable: "Sites",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
            // ----------------------------------------------------------------
            // SMART columns.
            //
            // Only three of session 3's counters have a counterpart in the
            // unified contract, and they are renamed rather than recreated so
            // their history survives. The rest describe attributes this
            // contract does not model and are dropped outright: carrying a
            // power-cycle count forward in a column labelled "pending sectors"
            // would put a harmless number where the health evaluator looks for
            // a failing drive.
            // ----------------------------------------------------------------

            migrationBuilder.RenameColumn(
                name: "CurrentPendingSectorCount",
                table: "SmartReadings",
                newName: "PendingSectorCount");

            migrationBuilder.RenameColumn(
                name: "ReportedUncorrectableErrors",
                table: "SmartReadings",
                newName: "UncorrectableErrorCount");

            foreach (string orphaned in new[]
                     {
                         "WearLevelingCount", "UnsafeShutdownCount", "UdmaCrcErrorCount",
                         "TotalHostWritesGb", "TotalHostReadsGb", "SpinRetryCount",
                         "SeekErrorRate", "SampleCount", "ReadErrorRate",
                         "PowerCycleCount", "PercentageUsed",
                     })
            {
                migrationBuilder.DropColumn(name: orphaned, table: "SmartReadings");
            }

            // Every reading that predates this migration came from the vendor
            // byte array, because that is the only source the agent had. Saying
            // so is the point of the column: a later trend query must be able
            // to tell decoded vendor bytes from a structured counter.
            migrationBuilder.AddColumn<int>(
                name: "Source",
                table: "SmartReadings",
                type: "INTEGER",
                nullable: false,
                defaultValue: 3);

            migrationBuilder.AddColumn<bool>(
                name: "OverallPredictFailure",
                table: "SmartReadings",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "PredictFailureReason",
                table: "SmartReadings",
                type: "INTEGER",
                nullable: true);

            foreach (string counter in new[] { "Wear", "TemperatureMax", "StartStopCycleCount" })
            {
                migrationBuilder.AddColumn<int>(
                    name: counter, table: "SmartReadings", type: "INTEGER", nullable: true);
            }

            foreach (string counter in new[]
                     {
                         "ReadErrorsTotal", "ReadErrorsUncorrected",
                         "WriteErrorsTotal", "WriteErrorsUncorrected",
                     })
            {
                migrationBuilder.AddColumn<long>(
                    name: counter, table: "SmartReadings", type: "INTEGER", nullable: true);
            }

            // ----------------------------------------------------------------
            // Client and site rows, from the names cabinets used to carry.
            //
            // The hierarchy is new, and a cabinet's client is now a security
            // boundary rather than a label — a cabinet-to-cabinet probe may not
            // cross it. Deriving it from the strings already stored is the only
            // way to preserve which cabinets belong together.
            //
            // Role is deliberately left Unknown. Nothing in the old schema
            // recorded which cabinet syncs a site, and guessing would put a
            // wrong answer where a Supervisor's decision belongs.
            // ----------------------------------------------------------------

            migrationBuilder.Sql(
                "INSERT INTO Clients (Id, Name) " +
                "SELECT DISTINCT lower(hex(randomblob(16))), ClientName FROM Cabinets " +
                "WHERE ClientName IS NOT NULL AND ClientName <> '';");

            migrationBuilder.Sql(
                "INSERT INTO Sites (Id, ClientId, Name, SyncCabinetId) " +
                "SELECT DISTINCT lower(hex(randomblob(16))), c.Id, cab.SiteName, NULL " +
                "FROM Cabinets cab JOIN Clients c ON c.Name = cab.ClientName " +
                "WHERE cab.SiteName IS NOT NULL AND cab.SiteName <> '';");

            migrationBuilder.Sql(
                "UPDATE Cabinets SET SiteId = (" +
                "SELECT s.Id FROM Sites s JOIN Clients c ON c.Id = s.ClientId " +
                "WHERE c.Name = Cabinets.ClientName AND s.Name = Cabinets.SiteName);");

            // ----------------------------------------------------------------
            // Check-ins become heartbeats.
            //
            // The projected columns carry over one for one; the stored payload
            // does not, because the tiers replace it — inventory now lives in
            // its own change history and SMART in its own series. Dropping the
            // table without this copy would throw away every cabinet's recent
            // history on upgrade.
            // ----------------------------------------------------------------

            migrationBuilder.Sql(
                "INSERT INTO Heartbeats (Id, CabinetId, ReceivedUtc, CollectedAtUtc, AgentVersion, " +
                "UptimeSeconds, CpuPercent, RamUsedPercent, MinFreeDiskPercent, WorstDiskHealth, " +
                "AnyUserLoggedOn, PendingUpdateCount, RebootPending, ClockDriftSeconds, " +
                "SectionErrorsJson, IsAggregated, SampleCount) " +
                "SELECT Id, CabinetId, ReceivedUtc, CollectedAtUtc, NULL, NULL, CpuPercent, " +
                "RamUsedPercent, MinFreeDiskPercent, WorstDiskHealth, AnyUserLoggedOn, " +
                "PendingUpdateCount, NULL, NULL, '{}', 0, 1 FROM CheckIns;");

            migrationBuilder.DropTable(name: "CheckIns");

            migrationBuilder.DropColumn(name: "ClientName", table: "Cabinets");

            migrationBuilder.DropColumn(name: "SiteName", table: "Cabinets");

        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Cabinets_Sites_SiteId",
                table: "Cabinets");

            migrationBuilder.DropTable(
                name: "BatchActionTargets");

            migrationBuilder.DropTable(
                name: "CabinetLinkProbes");

            migrationBuilder.DropTable(
                name: "Heartbeats");

            migrationBuilder.DropTable(
                name: "InventoryVersions");

            migrationBuilder.DropTable(
                name: "RefreshTokens");

            migrationBuilder.DropTable(
                name: "Sites");

            migrationBuilder.DropTable(
                name: "BatchActionRequests");

            migrationBuilder.DropTable(
                name: "Clients");

            migrationBuilder.DropIndex(
                name: "IX_SmartReadings_Cabinet_Drive_Timestamp_Desc",
                table: "SmartReadings");

            migrationBuilder.DropIndex(
                name: "IX_SmartReadings_CabinetId_TimestampUtc_Desc",
                table: "SmartReadings");

            migrationBuilder.DropIndex(
                name: "IX_Cabinets_Role",
                table: "Cabinets");

            migrationBuilder.DropIndex(
                name: "IX_Cabinets_SiteId",
                table: "Cabinets");

            migrationBuilder.DropIndex(
                name: "IX_AuditEntries_BatchId",
                table: "AuditEntries");

            migrationBuilder.DropIndex(
                name: "IX_AuditEntries_Event",
                table: "AuditEntries");

            migrationBuilder.DropIndex(
                name: "IX_ActionRequests_BatchId",
                table: "ActionRequests");

            migrationBuilder.DropColumn(
                name: "RowVersion",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "CurrentInventoryVersionId",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "LastFullCheckInUtc",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "LastKnownIpAddress",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "Role",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "RowVersion",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "SiteId",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "TimeZoneId",
                table: "Cabinets");

            migrationBuilder.DropColumn(
                name: "BatchId",
                table: "AuditEntries");

            migrationBuilder.DropColumn(
                name: "Event",
                table: "AuditEntries");

            migrationBuilder.DropColumn(
                name: "TargetCabinetHostname",
                table: "AuditEntries");

            migrationBuilder.DropColumn(
                name: "TargetCabinetId",
                table: "AuditEntries");

            migrationBuilder.DropColumn(
                name: "BatchId",
                table: "ActionRequests");

            migrationBuilder.DropColumn(
                name: "CollectedDataJson",
                table: "ActionRequests");

            migrationBuilder.DropColumn(
                name: "ExitCode",
                table: "ActionRequests");

            migrationBuilder.DropColumn(
                name: "IsCrossSiteTarget",
                table: "ActionRequests");

            migrationBuilder.DropColumn(
                name: "RowVersion",
                table: "ActionRequests");

            migrationBuilder.DropColumn(
                name: "StartedUtc",
                table: "ActionRequests");

            migrationBuilder.DropColumn(
                name: "TargetCabinetId",
                table: "ActionRequests");

            migrationBuilder.RenameColumn(
                name: "WriteErrorsUncorrected",
                table: "SmartReadings",
                newName: "WearLevelingCount");

            migrationBuilder.RenameColumn(
                name: "WriteErrorsTotal",
                table: "SmartReadings",
                newName: "UnsafeShutdownCount");

            migrationBuilder.RenameColumn(
                name: "Wear",
                table: "SmartReadings",
                newName: "UdmaCrcErrorCount");

            migrationBuilder.RenameColumn(
                name: "UncorrectableErrorCount",
                table: "SmartReadings",
                newName: "TotalHostWritesGb");

            migrationBuilder.RenameColumn(
                name: "TemperatureMax",
                table: "SmartReadings",
                newName: "TotalHostReadsGb");

            migrationBuilder.RenameColumn(
                name: "StartStopCycleCount",
                table: "SmartReadings",
                newName: "SpinRetryCount");

            migrationBuilder.RenameColumn(
                name: "Source",
                table: "SmartReadings",
                newName: "SampleCount");

            migrationBuilder.RenameColumn(
                name: "ReadErrorsUncorrected",
                table: "SmartReadings",
                newName: "SeekErrorRate");

            migrationBuilder.RenameColumn(
                name: "ReadErrorsTotal",
                table: "SmartReadings",
                newName: "ReportedUncorrectableErrors");

            migrationBuilder.RenameColumn(
                name: "PredictFailureReason",
                table: "SmartReadings",
                newName: "ReadErrorRate");

            migrationBuilder.RenameColumn(
                name: "PendingSectorCount",
                table: "SmartReadings",
                newName: "PowerCycleCount");

            migrationBuilder.RenameColumn(
                name: "OverallPredictFailure",
                table: "SmartReadings",
                newName: "PercentageUsed");

            migrationBuilder.RenameColumn(
                name: "Health",
                table: "SmartReadings",
                newName: "PredictedHealth");

            migrationBuilder.AddColumn<int>(
                name: "AvailableSparePercent",
                table: "SmartReadings",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "AvailableSpareThresholdPercent",
                table: "SmartReadings",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "CommandTimeoutCount",
                table: "SmartReadings",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "CurrentPendingSectorCount",
                table: "SmartReadings",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DeviceId",
                table: "SmartReadings",
                type: "TEXT",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "FirmwareVersion",
                table: "SmartReadings",
                type: "TEXT",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "MediaAndDataIntegrityErrors",
                table: "SmartReadings",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "OfflineUncorrectableCount",
                table: "SmartReadings",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ClientName",
                table: "Cabinets",
                type: "TEXT",
                maxLength: 255,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "SiteName",
                table: "Cabinets",
                type: "TEXT",
                maxLength: 255,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AlterColumn<string>(
                name: "ActorType",
                table: "AuditEntries",
                type: "TEXT",
                maxLength: 32,
                nullable: false,
                oldClrType: typeof(int),
                oldType: "INTEGER");

            migrationBuilder.AlterColumn<string>(
                name: "Action",
                table: "AuditEntries",
                type: "TEXT",
                maxLength: 128,
                nullable: false,
                defaultValue: "",
                oldClrType: typeof(int),
                oldType: "INTEGER",
                oldNullable: true);

            migrationBuilder.CreateTable(
                name: "CheckIns",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    CabinetId = table.Column<Guid>(type: "TEXT", nullable: false),
                    AnyUserLoggedOn = table.Column<bool>(type: "INTEGER", nullable: false),
                    CollectedAtUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    CpuPercent = table.Column<double>(type: "REAL", nullable: false),
                    MinFreeDiskPercent = table.Column<double>(type: "REAL", nullable: false),
                    PayloadJson = table.Column<string>(type: "TEXT", nullable: false),
                    PendingUpdateCount = table.Column<int>(type: "INTEGER", nullable: false),
                    RamUsedPercent = table.Column<double>(type: "REAL", nullable: false),
                    ReceivedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    WorstDiskHealth = table.Column<int>(type: "INTEGER", nullable: false)
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

            migrationBuilder.CreateIndex(
                name: "IX_SmartReadings_Cabinet_Drive_Timestamp",
                table: "SmartReadings",
                columns: new[] { "CabinetId", "DriveSerial", "TimestampUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_Cabinets_ClientName_SiteName",
                table: "Cabinets",
                columns: new[] { "ClientName", "SiteName" });

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
        }
    }
}

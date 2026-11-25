-- Database objects the code already uses but no migration created (audit of 2026-10-26, findings S7 and F2).
--
-- audit_head: the audit check compares the end of the log with the high-water mark the append procedures keep in audit_chain_head
-- (db.ts auditChainHeadAnchor), so deleting the newest entries is noticed. The application's role may not read that table; this
-- procedure, owned like the table, is its only window onto it (ownership chaining), and it can only read.
CREATE PROCEDURE audit_head
AS
BEGIN
  SET NOCOUNT ON;
  SELECT [seq], [hash] FROM audit_chain_head WHERE id = 1;
END
GO
GRANT EXECUTE ON audit_head TO cabinet_app;
GO

-- The file-facts paths (services/filefacts-allowlist.ts): one JSON column per scope with the fleet default as one settings row, the same
-- convention and the same check as the approved programs (0006): a JSON object holding at most 32 entries (program-path.ts MAX_FILES).
ALTER TABLE clients ADD [filefacts_paths] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL;
GO
ALTER TABLE clients ADD CONSTRAINT [clients_filefacts_paths_check] CHECK ([filefacts_paths] IS NULL OR (CASE WHEN ISJSON([filefacts_paths], OBJECT) = 1 THEN CASE WHEN JSON_QUERY([filefacts_paths], '$.entries[32]') IS NULL THEN 1 ELSE 0 END ELSE 0 END) = 1);
GO
ALTER TABLE sites ADD [filefacts_paths] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL;
GO
ALTER TABLE sites ADD CONSTRAINT [sites_filefacts_paths_check] CHECK ([filefacts_paths] IS NULL OR (CASE WHEN ISJSON([filefacts_paths], OBJECT) = 1 THEN CASE WHEN JSON_QUERY([filefacts_paths], '$.entries[32]') IS NULL THEN 1 ELSE 0 END ELSE 0 END) = 1);
GO
ALTER TABLE cabinets ADD [filefacts_paths] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL;
GO
ALTER TABLE cabinets ADD CONSTRAINT [cabinets_filefacts_paths_check] CHECK ([filefacts_paths] IS NULL OR (CASE WHEN ISJSON([filefacts_paths], OBJECT) = 1 THEN CASE WHEN JSON_QUERY([filefacts_paths], '$.entries[32]') IS NULL THEN 1 ELSE 0 END ELSE 0 END) = 1);
GO

-- The issue types three rules raise but nothing seeded, so their alerts could never open:
--   app_version    (filefacts-ingest.ts APP_VERSION_ISSUE): a tracked program's version differs from the baseline;
--   usb_flap       (usb-policy.ts, rule usb-flap): a USB device keeps disconnecting and coming back;
--   usb_dependency (usb-policy.ts, rule usb-dependency): a program or service a USB device needs is not running.
INSERT INTO issue_types ([id], [key], [name], [severity], [description], [built_in], [scope]) VALUES
  (N'00000000-0000-4000-8000-000000000124', N'app_version', N'Program version differs from the baseline', N'minor', N'A program the platform tracks on this cabinet is not at the version its baseline expects. Check whether it was updated on purpose; if so, update the baseline.', 1, N'cabinet'),
  (N'00000000-0000-4000-8000-000000000125', N'usb_flap', N'USB device reconnecting repeatedly', N'minor', N'A USB device on this cabinet disconnected and came back several times in a short period. Check the cable, the port and the hub, and the USB power settings.', 1, N'cabinet'),
  (N'00000000-0000-4000-8000-000000000126', N'usb_dependency', N'Software that uses this USB device is not running', N'minor', N'A program or service the USB device needs is not running on this cabinet, so the device cannot be used. Start it, or check why it stopped.', 1, N'cabinet');
GO

-- Whether the cabinet's agent says it accepts agent upgrades whose programs are not code-signed (heartbeat unsignedUpgrades: a development
-- build with no publisher compiled in). The console marks such a cabinet; production builds never report it, so it stays 0 for them.
ALTER TABLE cabinets ADD [unsigned_upgrades] bit NOT NULL CONSTRAINT [cabinets_unsigned_upgrades_default] DEFAULT 0;
GO

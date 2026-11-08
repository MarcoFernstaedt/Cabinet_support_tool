-- A service set to restart the computer when it fails (finding F14.R3, decision-log D43). services.list has always read each service's
-- recovery actions; nothing surfaced a "restart the computer" one. The issue type is minor: the setting is a risk, not a failure.
INSERT INTO issue_types ([id], [key], [name], [severity], [description], [built_in], [scope]) VALUES
  (N'00000000-0000-4000-8000-000000000127', N'service_reboot_recovery', N'Service set to restart the computer if it fails', N'minor', N'Windows is set to restart this cabinet when one of its services fails. A service that keeps failing can then restart the cabinet over and over, and each restart looks like a crash. Check whether the setting was meant, and change the service''s recovery actions if not.', 1, N'fleet');
GO

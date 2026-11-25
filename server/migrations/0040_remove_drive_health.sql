-- SMART and drive risk are removed (decision-log D152): the owner keeps free space only. The platform no longer reads drive health, so
-- the drive history and its per-drive status go, with the risk thresholds. The built-in rule that mapped an agent's smart_warning to the
-- drive issue is disabled, with its history row, so an agent before D152 opens no alert; the issue type stays, for the alerts it raised.
DROP TABLE drive_status;
DROP TABLE drive_samples;
GO
DELETE FROM settings WHERE [key] LIKE N'drives.%';
UPDATE symptom_rules SET [state] = N'disabled', [updated_at] = SYSUTCDATETIME()
 WHERE [id] = N'00000000-0000-4000-8000-000000000202' AND [state] = N'live';
INSERT INTO symptom_rule_history ([rule_id], [version], [change], [state], [issue_type_id], [match], [severity])
SELECT [id], [version], N'disabled', [state], [issue_type_id], [match], [severity] FROM symptom_rules
 WHERE [id] = N'00000000-0000-4000-8000-000000000202' AND [state] = N'disabled'
   AND NOT EXISTS (SELECT 1 FROM symptom_rule_history h WHERE h.[rule_id] = N'00000000-0000-4000-8000-000000000202' AND h.[change] = N'disabled');
GO

-- The file-facts read is removed (decision-log D150): the owner does not want the platform reading file details on a cabinet, and
-- its agent operation was never built, so nothing was ever read. This drops what 0010 added for it: the three scope columns and their
-- checks, the fleet default's settings row, and the issue type only that read raised, when nothing refers to it.
ALTER TABLE clients DROP CONSTRAINT [clients_filefacts_paths_check];
ALTER TABLE clients DROP COLUMN [filefacts_paths];
ALTER TABLE sites DROP CONSTRAINT [sites_filefacts_paths_check];
ALTER TABLE sites DROP COLUMN [filefacts_paths];
ALTER TABLE cabinets DROP CONSTRAINT [cabinets_filefacts_paths_check];
ALTER TABLE cabinets DROP COLUMN [filefacts_paths];
GO
DELETE FROM settings WHERE [key] = N'filefacts.paths';
DELETE FROM issue_types WHERE [id] = N'00000000-0000-4000-8000-000000000124'
  AND NOT EXISTS (SELECT 1 FROM alerts WHERE [issue_type_id] = N'00000000-0000-4000-8000-000000000124')
  AND NOT EXISTS (SELECT 1 FROM symptom_rules WHERE [issue_type_id] = N'00000000-0000-4000-8000-000000000124')
  AND NOT EXISTS (SELECT 1 FROM known_fixes WHERE [issue_type_id] = N'00000000-0000-4000-8000-000000000124')
  AND NOT EXISTS (SELECT 1 FROM runbooks WHERE [issue_type_id] = N'00000000-0000-4000-8000-000000000124');
GO

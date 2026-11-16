-- Keep 0036's checksum intact for databases that already applied it.
-- Recreate the column so its JSON check remains a column-level constraint,
-- as required by the schema's JSON-column inventory. Migration batches share
-- one transaction, so no application can observe the intermediate shape.
DECLARE @check sysname;
SELECT @check = cc.name FROM sys.check_constraints cc
  JOIN sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id
  WHERE cc.parent_object_id = OBJECT_ID('session_shell_frames') AND c.name = 'frame';
IF @check IS NULL THROW 50000, 'Missing shell frame JSON constraint', 1;
DECLARE @drop nvarchar(max) = N'ALTER TABLE session_shell_frames DROP CONSTRAINT ' + QUOTENAME(@check);
EXEC sp_executesql @drop;
EXEC sp_rename 'session_shell_frames.frame', 'frame_legacy', 'COLUMN';
GO
ALTER TABLE session_shell_frames ADD frame varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL
  CONSTRAINT session_shell_frames_frame_default DEFAULT '{}'
  CONSTRAINT session_shell_frames_json CHECK (ISJSON(frame) = 1);
GO
UPDATE session_shell_frames SET frame = frame_legacy;
GO
ALTER TABLE session_shell_frames DROP COLUMN frame_legacy;
ALTER TABLE session_shell_frames DROP CONSTRAINT session_shell_frames_frame_default;
GO

-- Development branch only: absence of a capability report is always false.
ALTER TABLE cabinets ADD development_shell bit NOT NULL CONSTRAINT cabinets_shell_default DEFAULT 0;
GO
CREATE TABLE session_shell_frames (
  seq bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
  session_id uniqueidentifier NOT NULL REFERENCES remote_sessions(id),
  direction nvarchar(8) NOT NULL CHECK (direction IN ('agent','console')),
  frame nvarchar(max) NOT NULL CHECK (ISJSON(frame) = 1),
  recorded_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
  delivered_at datetime2(3) NULL
);
GO
CREATE INDEX session_shell_delivery ON session_shell_frames(session_id, direction, delivered_at, seq);
GO
GRANT SELECT, INSERT, UPDATE ON session_shell_frames TO cabinet_app;
DENY DELETE ON session_shell_frames TO cabinet_app;
GO
CREATE TABLE session_shell_commands (
  seq bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
  session_id uniqueidentifier NOT NULL REFERENCES remote_sessions(id),
  input_data nvarchar(max) NOT NULL,
  complete bit NOT NULL,
  recorded_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX session_shell_command_log ON session_shell_commands(session_id, seq);
GO
GRANT SELECT, INSERT, UPDATE ON session_shell_commands TO cabinet_app;
DENY DELETE ON session_shell_commands TO cabinet_app;
GO

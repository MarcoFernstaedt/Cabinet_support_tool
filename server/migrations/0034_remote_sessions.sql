-- Durable remote-access history. Nothing in this migration enables the transport.
CREATE TABLE remote_sessions (
  [id] uniqueidentifier NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [operator_id] uniqueidentifier NOT NULL,
  [kind] nvarchar(64) NOT NULL,
  [open_reason] nvarchar(1000) NOT NULL,
  [opened_at] datetime2(3) NOT NULL CONSTRAINT [remote_sessions_opened_default] DEFAULT SYSUTCDATETIME(),
  [last_seen_at] datetime2(3) NOT NULL CONSTRAINT [remote_sessions_seen_default] DEFAULT SYSUTCDATETIME(),
  [closed_at] datetime2(3) NULL,
  [end_kind] nvarchar(16) NULL,
  [close_reason] nvarchar(1000) NULL,
  CONSTRAINT [remote_sessions_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [remote_sessions_cabinet_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]),
  CONSTRAINT [remote_sessions_operator_fkey] FOREIGN KEY ([operator_id]) REFERENCES users([id]),
  CONSTRAINT [remote_sessions_kind_check] CHECK (LEN(LTRIM(RTRIM([kind]))) BETWEEN 1 AND 64),
  CONSTRAINT [remote_sessions_open_reason_check] CHECK (LEN(LTRIM(RTRIM([open_reason]))) BETWEEN 1 AND 1000),
  CONSTRAINT [remote_sessions_seen_check] CHECK ([last_seen_at] >= [opened_at]),
  CONSTRAINT [remote_sessions_close_check] CHECK (
    ([closed_at] IS NULL AND [end_kind] IS NULL AND [close_reason] IS NULL) OR
    ([closed_at] IS NOT NULL AND [closed_at] >= [last_seen_at] AND
     [end_kind] IS NOT NULL AND [end_kind] IN ('explicit', 'idle', 'killed', 'error') AND
     [close_reason] IS NOT NULL AND LEN(LTRIM(RTRIM([close_reason]))) BETWEEN 1 AND 1000))
);
GO
-- This backstop also protects against two server instances opening the same cabinet.
CREATE UNIQUE INDEX remote_sessions_one_live_cabinet ON remote_sessions ([cabinet_id]) WHERE [closed_at] IS NULL;
GO
GRANT INSERT, SELECT, UPDATE ON remote_sessions TO cabinet_app;
DENY DELETE ON remote_sessions TO cabinet_app;
GO

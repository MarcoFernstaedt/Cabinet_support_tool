-- Fleet patterns (decision-log D22): the same problem on cabinets at many sites within a window is one fleet alert, with how many
-- clients, sites and cabinets it reaches. The key is the alerts' own grouping: issue:<issue type> for a known issue, else the alert
-- signature (an unrecognized error from one log, source and event ID), with demo| in front for demo cabinets, so the demo fleet is a
-- pattern of its own. One open pattern per key.
CREATE TABLE fleet_patterns (
  [id] uniqueidentifier NOT NULL DEFAULT NEWID(),
  [pattern_key] nvarchar(460) NOT NULL,
  [issue_type_id] uniqueidentifier NULL,
  [title] nvarchar(300) NOT NULL,
  [severity] nvarchar(16) NOT NULL,
  [clients] int NOT NULL,
  [sites] int NOT NULL,
  [cabinets] int NOT NULL,
  [occurrences] bigint NOT NULL,
  [first_seen] datetime2(3) NOT NULL,
  [last_seen] datetime2(3) NOT NULL,
  [opened_at] datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
  [resolved_at] datetime2(3) NULL,
  CONSTRAINT [fleet_patterns_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [fleet_patterns_issue_fk] FOREIGN KEY ([issue_type_id]) REFERENCES issue_types ([id]),
  CONSTRAINT [fleet_patterns_severity_check] CHECK ([severity] IN ('major', 'minor')),
  CONSTRAINT [fleet_patterns_counts_check] CHECK ([clients] >= 1 AND [sites] >= 1 AND [cabinets] >= 1 AND [occurrences] >= 1),
  CONSTRAINT [fleet_patterns_title_check] CHECK (LEN([title]) BETWEEN 1 AND 300)
);
GO
CREATE UNIQUE INDEX fleet_patterns_one_open ON fleet_patterns ([pattern_key]) WHERE [resolved_at] IS NULL;
GO
CREATE INDEX fleet_patterns_recent ON fleet_patterns ([opened_at] DESC);
GO
GRANT INSERT, SELECT, UPDATE ON fleet_patterns TO cabinet_app;
GO

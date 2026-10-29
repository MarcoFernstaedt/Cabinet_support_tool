-- The unified incident record (docs/platform/diagnostic-engine-execution.md, "The foundation in detail", item 2). One incident is one problem
-- on one cabinet, followed from the symptom through the evidence, the likely cause, the repair proposed, its approval, what was run, and
-- whether it was verified. Each of those is a step, appended in order and never changed; the incident's state follows from its steps. Links
-- name the alerts, diagnoses, commands, case notes and fleet jobs it came from or produced: plain identifiers, kept by their own rules, so
-- a link can outlive what it names and is then shown as gone.
--
-- Removed with its cabinet. A closed incident is kept as long as resolved alerts are (the same setting); an open one is never removed.
-- Every step is also written to the audit log by the service that appends it.

CREATE TABLE incidents (
  [id] uniqueidentifier NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [state] nvarchar(20) NOT NULL CONSTRAINT [incidents_state_default] DEFAULT 'open',
  [symptom] nvarchar(200) NOT NULL,
  [module_id] nvarchar(64) NULL,
  [module_version] int NULL,
  [opened_by_kind] nvarchar(8) NOT NULL,
  [opened_by] nvarchar(64) NOT NULL,
  [opened_at] datetime2(3) NOT NULL CONSTRAINT [incidents_opened_default] DEFAULT SYSUTCDATETIME(),
  [updated_at] datetime2(3) NOT NULL CONSTRAINT [incidents_updated_default] DEFAULT SYSUTCDATETIME(),
  [closed_at] datetime2(3) NULL,
  [outcome] nvarchar(300) NULL,
  CONSTRAINT [incidents_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [incidents_state_check] CHECK ([state] IN ('open', 'awaiting_approval', 'approved', 'repairing', 'resolved', 'unresolved')),
  CONSTRAINT [incidents_opened_by_kind_check] CHECK ([opened_by_kind] IN ('user', 'system')),
  CONSTRAINT [incidents_module_check] CHECK (([module_id] IS NULL AND [module_version] IS NULL) OR ([module_id] IS NOT NULL AND [module_version] >= 1)),
  CONSTRAINT [incidents_closed_check] CHECK ([state] NOT IN ('resolved', 'unresolved') OR [closed_at] IS NOT NULL),
  CONSTRAINT [incidents_symptom_check] CHECK (LEN([symptom]) BETWEEN 1 AND 200),
  CONSTRAINT [incidents_outcome_check] CHECK (LEN([outcome]) <= 300)
);
GO
ALTER TABLE incidents ADD CONSTRAINT [incidents_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
GO
CREATE INDEX incidents_cabinet ON incidents ([cabinet_id], [opened_at] DESC);
GO
CREATE INDEX incidents_closed ON incidents ([closed_at]) WHERE [closed_at] IS NOT NULL;
GO

CREATE TABLE incident_steps (
  [incident_id] uniqueidentifier NOT NULL,
  [position] int NOT NULL,
  [kind] nvarchar(20) NOT NULL,
  [actor_kind] nvarchar(8) NOT NULL,
  [actor_id] nvarchar(64) NOT NULL,
  [at] datetime2(3) NOT NULL CONSTRAINT [incident_steps_at_default] DEFAULT SYSUTCDATETIME(),
  [summary] nvarchar(300) NOT NULL,
  [detail] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL,
  CONSTRAINT [incident_steps_pkey] PRIMARY KEY ([incident_id], [position]),
  CONSTRAINT [incident_steps_kind_check] CHECK ([kind] IN ('symptom', 'evidence', 'hypothesis', 'proposed_repair', 'approval', 'execution', 'verification', 'note', 'close')),
  CONSTRAINT [incident_steps_actor_kind_check] CHECK ([actor_kind] IN ('user', 'system')),
  CONSTRAINT [incident_steps_position_check] CHECK ([position] >= 1),
  CONSTRAINT [incident_steps_summary_check] CHECK (LEN([summary]) BETWEEN 1 AND 300),
  CONSTRAINT [incident_steps_detail_json] CHECK ([detail] IS NULL OR (ISJSON([detail], OBJECT) = 1 AND DATALENGTH([detail]) <= 8192))
);
GO
ALTER TABLE incident_steps ADD CONSTRAINT [incident_steps_incident_id_fkey] FOREIGN KEY ([incident_id]) REFERENCES incidents([id]) ON DELETE CASCADE;
GO

CREATE TABLE incident_links (
  [incident_id] uniqueidentifier NOT NULL,
  [kind] nvarchar(16) NOT NULL,
  [ref_id] uniqueidentifier NOT NULL,
  [linked_at] datetime2(3) NOT NULL CONSTRAINT [incident_links_linked_default] DEFAULT SYSUTCDATETIME(),
  CONSTRAINT [incident_links_pkey] PRIMARY KEY ([incident_id], [kind], [ref_id]),
  CONSTRAINT [incident_links_kind_check] CHECK ([kind] IN ('alert', 'diagnosis', 'command', 'case_note', 'fleet_job'))
);
GO
ALTER TABLE incident_links ADD CONSTRAINT [incident_links_incident_id_fkey] FOREIGN KEY ([incident_id]) REFERENCES incidents([id]) ON DELETE CASCADE;
GO
CREATE INDEX incident_links_ref ON incident_links ([kind], [ref_id]);
GO

-- Steps and links are appended and never changed: the app may insert and read them, and only deletes them with their incident (cascade).
GRANT DELETE, INSERT, SELECT, UPDATE ON incidents TO cabinet_app;
GRANT INSERT, SELECT ON incident_steps TO cabinet_app;
GRANT INSERT, SELECT ON incident_links TO cabinet_app;
GO

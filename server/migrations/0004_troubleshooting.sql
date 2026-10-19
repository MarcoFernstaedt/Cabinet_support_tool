-- The troubleshooting workflow (docs/spec/12-milestones-8-to-12.md "Milestone 12", docs/spec/13-roadmap.md "The troubleshooting workflow"):
-- the cabinet diagnosis (a second kind of stored diagnosis), runbooks, case notes and resolution notes, and the nightly error trends.

-- ---- Diagnose this cabinet: a diagnosis is now of kind 'network' or 'cabinet' ----------------------------------------------------------
ALTER TABLE diagnoses DROP CONSTRAINT diagnoses_kind_check;
GO
ALTER TABLE diagnoses ADD CONSTRAINT diagnoses_kind_check CHECK (kind IN ('network', 'cabinet'));
GO

-- ---- Resolution notes: what was wrong and what fixed it, on the alert itself -----------------------------------------------------------
-- resolution (the existing column) stays the short note shown on the alert; these three are the structured part that "usually fixed by" counts.
ALTER TABLE alerts ADD [resolution_cause] nvarchar(500) NULL, [resolution_fix] nvarchar(256) NULL, [resolution_fix_id] uniqueidentifier NULL;
GO
-- (resolution_fix_id has no foreign key: known_fixes.alert_id already points the other way with ON DELETE SET NULL, and two such links
-- would be a cycle. A removed fix leaves its text in resolution_fix, which is what is counted.)
-- Only resolved alerts with a fix are counted, so the index stays small however many alerts there are.
CREATE INDEX alerts_resolution_fix ON alerts ([issue_type_id], [resolved_at]) INCLUDE ([resolution_fix], [resolution_fix_id]) WHERE resolution_fix IS NOT NULL;
GO

-- ---- Case notes: who did what to a cabinet, optionally tied to an alert --------------------------------------------------------------
-- Append-only (the trigger below): a note is never edited. An Admin can remove the text of one (a password pasted by mistake); the note,
-- its author and the redaction stay.
CREATE TABLE case_notes (
  [id] uniqueidentifier NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [alert_id] uniqueidentifier NULL,
  [author_id] uniqueidentifier NOT NULL,
  [kind] nvarchar(16) NOT NULL CONSTRAINT [case_notes_kind_default] DEFAULT 'note',
  [body] nvarchar(2000) NOT NULL,
  [created_at] datetime2(3) NOT NULL CONSTRAINT [case_notes_created_default] DEFAULT SYSUTCDATETIME(),
  [redacted_at] datetime2(3) NULL,
  [redacted_by] uniqueidentifier NULL,
  [redacted_reason] nvarchar(200) NULL,
  CONSTRAINT [case_notes_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [case_notes_kind_check] CHECK (kind IN ('note', 'resolution')),
  CONSTRAINT [case_notes_body_check] CHECK (LEN(body) <= 2000),
  CONSTRAINT [case_notes_redaction_check] CHECK ((redacted_at IS NULL AND redacted_by IS NULL AND redacted_reason IS NULL) OR (redacted_at IS NOT NULL AND redacted_by IS NOT NULL AND redacted_reason IS NOT NULL))
);
GO
ALTER TABLE case_notes ADD CONSTRAINT [case_notes_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
ALTER TABLE case_notes ADD CONSTRAINT [case_notes_alert_id_fkey] FOREIGN KEY ([alert_id]) REFERENCES alerts([id]) ON DELETE SET NULL;
ALTER TABLE case_notes ADD CONSTRAINT [case_notes_author_id_fkey] FOREIGN KEY ([author_id]) REFERENCES users([id]);
ALTER TABLE case_notes ADD CONSTRAINT [case_notes_redacted_by_fkey] FOREIGN KEY ([redacted_by]) REFERENCES users([id]);
GO
CREATE INDEX case_notes_cabinet ON case_notes ([cabinet_id], [created_at] DESC);
CREATE INDEX case_notes_alert ON case_notes ([alert_id]) WHERE alert_id IS NOT NULL;
GO
CREATE TRIGGER case_notes_append_only ON case_notes AFTER UPDATE AS
BEGIN
  IF @@ROWCOUNT = 0 RETURN;
  SET NOCOUNT ON;
  -- Nothing but a first redaction may change a note (the alert link may be cleared when its alert is deleted by retention).
  IF UPDATE([author_id]) OR UPDATE([cabinet_id]) OR UPDATE([created_at]) OR UPDATE([kind])
     OR EXISTS (SELECT 1 FROM deleted d WHERE d.redacted_at IS NOT NULL)
     OR (UPDATE([body]) AND EXISTS (SELECT 1 FROM inserted i WHERE i.redacted_at IS NULL))
    THROW 50010, 'case notes are append-only: only an Admin redaction may change one', 1;
END
GO

-- ---- Runbooks: step lists attached to an issue type or a diagnosis finding ------------------------------------------------------------
-- One live (approved) runbook per target; approving a new one retires the old. details is {"steps":[...],"links":[...]}, checked against
-- the runbook-propose contract and the operation catalog before it is stored. (The column is called details, like the audit log's, so the
-- database layer parses it: see src/db/json-columns.ts.)
CREATE TABLE runbooks (
  [id] uniqueidentifier NOT NULL,
  [issue_type_id] uniqueidentifier NULL,
  [finding_key] nvarchar(48) NULL,
  [title] nvarchar(120) NOT NULL,
  [details] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL,
  [state] nvarchar(16) NOT NULL,
  [version] int NOT NULL,
  [proposed_by] uniqueidentifier NOT NULL,
  [proposed_at] datetime2(3) NOT NULL CONSTRAINT [runbooks_proposed_default] DEFAULT SYSUTCDATETIME(),
  [decided_by] uniqueidentifier NULL,
  [decided_at] datetime2(3) NULL,
  CONSTRAINT [runbooks_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [runbooks_details_json] CHECK (ISJSON([details], VALUE) = 1),
  CONSTRAINT [runbooks_state_check] CHECK (state IN ('proposed', 'approved', 'rejected', 'retired')),
  CONSTRAINT [runbooks_target_check] CHECK ((issue_type_id IS NULL AND finding_key IS NOT NULL) OR (issue_type_id IS NOT NULL AND finding_key IS NULL)),
  CONSTRAINT [runbooks_finding_key_check] CHECK (finding_key IS NULL OR (LEN(finding_key) BETWEEN 1 AND 48 AND finding_key COLLATE Latin1_General_100_BIN2 LIKE '[a-z]%' AND finding_key COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^a-z0-9-]%')),
  CONSTRAINT [runbooks_title_check] CHECK (LEN(title) BETWEEN 1 AND 120),
  CONSTRAINT [runbooks_decision_check] CHECK ((state = 'proposed' AND decided_by IS NULL) OR (state <> 'proposed' AND decided_by IS NOT NULL))
);
GO
ALTER TABLE runbooks ADD CONSTRAINT [runbooks_issue_type_id_fkey] FOREIGN KEY ([issue_type_id]) REFERENCES issue_types([id]);
ALTER TABLE runbooks ADD CONSTRAINT [runbooks_proposed_by_fkey] FOREIGN KEY ([proposed_by]) REFERENCES users([id]);
ALTER TABLE runbooks ADD CONSTRAINT [runbooks_decided_by_fkey] FOREIGN KEY ([decided_by]) REFERENCES users([id]);
GO
CREATE UNIQUE INDEX runbooks_one_live_issue ON runbooks ([issue_type_id]) WHERE state = 'approved' AND issue_type_id IS NOT NULL;
CREATE UNIQUE INDEX runbooks_one_live_finding ON runbooks ([finding_key]) WHERE state = 'approved' AND finding_key IS NOT NULL;
CREATE INDEX runbooks_state ON runbooks ([state], [proposed_at]);
GO

-- ---- Error trends: one row per day, client and error, computed once a night from the events of that day -----------------------------
-- Days are UTC dates of when the platform received the events. Kept 35 days. No foreign keys: a removed client's rows simply stop being shown.
CREATE TABLE error_daily (
  [day] date NOT NULL,
  [client_id] uniqueidentifier NOT NULL,
  [log] nvarchar(128) NOT NULL,
  [source] nvarchar(256) NOT NULL,
  [event_id] int NOT NULL,
  [issue_type_id] uniqueidentifier NULL,
  [cabinets] int NOT NULL,
  [events] int NOT NULL,
  [sample] nvarchar(300) NULL,
  CONSTRAINT [error_daily_pkey] PRIMARY KEY ([day], [client_id], [log], [source], [event_id])
) WITH (DATA_COMPRESSION = PAGE);
GO
CREATE TABLE issue_daily (
  [day] date NOT NULL,
  [client_id] uniqueidentifier NOT NULL,
  [issue_type_id] uniqueidentifier NOT NULL,
  [cabinets] int NOT NULL,
  [events] int NOT NULL,
  CONSTRAINT [issue_daily_pkey] PRIMARY KEY ([day], [client_id], [issue_type_id])
) WITH (DATA_COMPRESSION = PAGE);
GO
-- The last day computed (one row), so a night that was missed is made up for.
CREATE TABLE trend_state (
  [id] int NOT NULL,
  [computed_through] date NULL,
  [computed_at] datetime2(3) NULL,
  CONSTRAINT [trend_state_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [trend_state_one_row] CHECK (id = 1)
);
INSERT INTO trend_state ([id]) VALUES (1);
GO

-- ---- Rights of the application's role --------------------------------------------------------------------------------------------------
GRANT INSERT, SELECT, UPDATE ON case_notes TO cabinet_app;
GRANT INSERT, SELECT, UPDATE ON runbooks TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON error_daily TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON issue_daily TO cabinet_app;
GRANT SELECT, UPDATE ON trend_state TO cabinet_app;
GO

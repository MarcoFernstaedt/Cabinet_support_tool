-- Configuration snapshots, change records, approved baselines, drift, health and last known healthy state
-- (docs/spec/15-baselines-and-config.md). Everything here is the platform's own record of what a cabinet reports about itself: Windows
-- settings only, never file contents, the cabinet application's data or the Security log.

-- ---- What the cabinet says it is -----------------------------------------------------------------------------------------------------------
-- Kept from the "system" part of its configuration report, so the baseline for a cabinet model can apply to it. The platform never guesses a model from a name.
ALTER TABLE cabinets ADD [manufacturer] nvarchar(200) NULL, [model] nvarchar(200) NULL;
GO
ALTER TABLE cabinets ADD CONSTRAINT [cabinets_model_check] CHECK ((manufacturer IS NULL OR LEN(manufacturer) <= 200) AND (model IS NULL OR LEN(model) <= 200));
GO

-- ---- Every distinct configuration a cabinet has had, per category --------------------------------------------------------------------------
-- Stored only when something changed (the agent sends only changed categories). items is the gzip of the JSON array of the category's items,
-- compressed by the server: a cabinet's configuration is a few hundred KB of text, and 8,000 cabinets must fit SQL Server Express. The
-- hash is the SHA-256 the agent computed and the server recomputed (config-canonical.ts), so a stored hash always describes the stored items.
CREATE TABLE config_versions (
  [id] bigint IDENTITY(1,1) NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [category] nvarchar(16) NOT NULL,
  [hash] char(64) NOT NULL,
  [items] varbinary(max) NOT NULL,
  [item_count] int NOT NULL,
  [truncated] bit NOT NULL CONSTRAINT [config_versions_truncated_default] DEFAULT 0,
  [first_observed_at] datetime2(3) NOT NULL,
  [last_observed_at] datetime2(3) NOT NULL,
  [not_before] datetime2(3) NULL,
  [gap_before] bit NOT NULL CONSTRAINT [config_versions_gap_default] DEFAULT 0,
  [source] nvarchar(16) NOT NULL,
  CONSTRAINT [config_versions_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [config_versions_category_check] CHECK (category IN ('network', 'services', 'drivers', 'updates', 'firewall', 'time', 'devices', 'applications', 'hosts', 'tasks', 'system')),
  CONSTRAINT [config_versions_hash_check] CHECK (hash COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9a-f]%'),
  CONSTRAINT [config_versions_count_check] CHECK (item_count BETWEEN 0 AND 2000),
  CONSTRAINT [config_versions_source_check] CHECK (source IN ('agent', 'refresh'))
);
GO
ALTER TABLE config_versions ADD CONSTRAINT [config_versions_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
GO
CREATE INDEX config_versions_by_cabinet ON config_versions ([cabinet_id], [category], [id] DESC);
GO

-- The configuration in force: one row per cabinet and category, pointing at its version. version_id has no foreign key: the old-version
-- pruning never removes the version a row here points at, and a second cascade path from cabinets is not allowed.
CREATE TABLE config_current (
  [cabinet_id] uniqueidentifier NOT NULL,
  [category] nvarchar(16) NOT NULL,
  [hash] char(64) NOT NULL,
  [version_id] bigint NOT NULL,
  [item_count] int NOT NULL,
  [truncated] bit NOT NULL CONSTRAINT [config_current_truncated_default] DEFAULT 0,
  [observed_at] datetime2(3) NOT NULL,
  [changed_at] datetime2(3) NOT NULL,
  CONSTRAINT [config_current_pkey] PRIMARY KEY ([cabinet_id], [category]),
  CONSTRAINT [config_current_category_check] CHECK (category IN ('network', 'services', 'drivers', 'updates', 'firewall', 'time', 'devices', 'applications', 'hosts', 'tasks', 'system'))
);
GO
ALTER TABLE config_current ADD CONSTRAINT [config_current_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
GO

-- What changed between two consecutive versions, item by item. The window (not_before to observed_at) is what is known: an exact time
-- is never invented, and exact_at is set only when Windows itself dated the change (an update's install time, say). version_id has no
-- foreign key: a change record outlives the old version it came from (it is pruned by age, not with the version).
CREATE TABLE config_changes (
  [id] bigint IDENTITY(1,1) NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [version_id] bigint NOT NULL,
  [category] nvarchar(16) NOT NULL,
  [item_key] nvarchar(200) NOT NULL,
  [change] nvarchar(8) NOT NULL,
  [fields] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL,
  [not_before] datetime2(3) NULL,
  [observed_at] datetime2(3) NOT NULL,
  [exact_at] datetime2(3) NULL,
  [gap] bit NOT NULL CONSTRAINT [config_changes_gap_default] DEFAULT 0,
  [via_platform] bit NOT NULL CONSTRAINT [config_changes_via_platform_default] DEFAULT 0,
  [violates_baseline] bit NOT NULL CONSTRAINT [config_changes_violates_default] DEFAULT 0,
  CONSTRAINT [config_changes_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [config_changes_fields_json] CHECK (ISJSON([fields], VALUE) = 1),
  CONSTRAINT [config_changes_change_check] CHECK (change IN ('added', 'removed', 'changed')),
  CONSTRAINT [config_changes_category_check] CHECK (category IN ('network', 'services', 'drivers', 'updates', 'firewall', 'time', 'devices', 'applications', 'hosts', 'tasks', 'system'))
) WITH (DATA_COMPRESSION = PAGE);
GO
ALTER TABLE config_changes ADD CONSTRAINT [config_changes_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
GO
CREATE INDEX config_changes_by_cabinet ON config_changes ([cabinet_id], [observed_at] DESC) WITH (DATA_COMPRESSION = PAGE);
CREATE INDEX config_changes_by_item ON config_changes ([cabinet_id], [category], [item_key], [observed_at] DESC) WITH (DATA_COMPRESSION = PAGE);
CREATE INDEX config_changes_by_age ON config_changes ([observed_at]) WITH (DATA_COMPRESSION = PAGE);
GO

-- ---- Baselines: one per scope; each has numbered versions that are never overwritten ----------------------------------------------------------
CREATE TABLE baselines (
  [id] uniqueidentifier NOT NULL,
  [scope_kind] nvarchar(16) NOT NULL,
  [scope_id] nvarchar(64) NULL,
  [name] nvarchar(200) NOT NULL,
  [created_by] uniqueidentifier NOT NULL,
  [created_at] datetime2(3) NOT NULL CONSTRAINT [baselines_created_default] DEFAULT SYSUTCDATETIME(),
  CONSTRAINT [baselines_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [baselines_scope_kind_check] CHECK (scope_kind IN ('global', 'model', 'client', 'site', 'cabinet')),
  CONSTRAINT [baselines_scope_check] CHECK ((scope_kind = 'global' AND scope_id IS NULL) OR (scope_kind <> 'global' AND scope_id IS NOT NULL AND LEN(scope_id) BETWEEN 1 AND 64)),
  CONSTRAINT [baselines_name_check] CHECK (LEN(name) BETWEEN 1 AND 200)
);
GO
ALTER TABLE baselines ADD CONSTRAINT [baselines_created_by_fkey] FOREIGN KEY ([created_by]) REFERENCES users([id]);
GO
-- (A unique index treats the one NULL scope_id, the global baseline's, as a value, so there is one baseline per scope.)
CREATE UNIQUE INDEX baselines_one_per_scope ON baselines ([scope_kind], [scope_id]);
GO

CREATE TABLE baseline_versions (
  [id] uniqueidentifier NOT NULL,
  [baseline_id] uniqueidentifier NOT NULL,
  [version] int NOT NULL,
  [status] nvarchar(16) NOT NULL,
  [content] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL,
  [description] nvarchar(500) NOT NULL,
  [previous_version_id] uniqueidentifier NULL,
  [compat] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL,
  [origin] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL,
  [created_by] uniqueidentifier NOT NULL,
  [created_at] datetime2(3) NOT NULL CONSTRAINT [baseline_versions_created_default] DEFAULT SYSUTCDATETIME(),
  [proposed_at] datetime2(3) NULL,
  [decided_by] uniqueidentifier NULL,
  [decided_at] datetime2(3) NULL,
  [decision_note] nvarchar(500) NULL,
  CONSTRAINT [baseline_versions_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [baseline_versions_baseline_version_key] UNIQUE ([baseline_id], [version]),
  CONSTRAINT [baseline_versions_content_json] CHECK (ISJSON([content], VALUE) = 1),
  CONSTRAINT [baseline_versions_compat_json] CHECK ([compat] IS NULL OR ISJSON([compat], VALUE) = 1),
  CONSTRAINT [baseline_versions_origin_json] CHECK ([origin] IS NULL OR ISJSON([origin], VALUE) = 1),
  CONSTRAINT [baseline_versions_version_check] CHECK ([version] >= 1),
  CONSTRAINT [baseline_versions_status_check] CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'superseded')),
  CONSTRAINT [baseline_versions_description_check] CHECK (LEN(description) BETWEEN 3 AND 500),
  CONSTRAINT [baseline_versions_decision_note_check] CHECK (decision_note IS NULL OR LEN(decision_note) <= 500),
  CONSTRAINT [baseline_versions_decision_check] CHECK ((status IN ('draft', 'pending') AND decided_by IS NULL) OR (status IN ('approved', 'rejected', 'superseded') AND decided_by IS NOT NULL))
);
GO
ALTER TABLE baseline_versions ADD CONSTRAINT [baseline_versions_baseline_id_fkey] FOREIGN KEY ([baseline_id]) REFERENCES baselines([id]);
ALTER TABLE baseline_versions ADD CONSTRAINT [baseline_versions_previous_fkey] FOREIGN KEY ([previous_version_id]) REFERENCES baseline_versions([id]);
ALTER TABLE baseline_versions ADD CONSTRAINT [baseline_versions_created_by_fkey] FOREIGN KEY ([created_by]) REFERENCES users([id]);
ALTER TABLE baseline_versions ADD CONSTRAINT [baseline_versions_decided_by_fkey] FOREIGN KEY ([decided_by]) REFERENCES users([id]);
GO
-- At most one version of a baseline is in force, and at most one is waiting for a decision.
CREATE UNIQUE INDEX baseline_one_approved ON baseline_versions ([baseline_id]) WHERE status = 'approved';
CREATE UNIQUE INDEX baseline_one_pending ON baseline_versions ([baseline_id]) WHERE status = 'pending';
GO

-- A decided version is history: only a draft's content or description may change, a version is never deleted, and a version only moves
-- forward (draft, pending, then approved or rejected; approved, then superseded; a pending one may go back to a draft).
CREATE TRIGGER baseline_versions_guard ON baseline_versions AFTER UPDATE AS
BEGIN
  IF @@ROWCOUNT = 0 RETURN;
  SET NOCOUNT ON;
  IF EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.id = i.id
              WHERE i.baseline_id <> d.baseline_id OR i.[version] <> d.[version] OR i.created_by <> d.created_by OR i.created_at <> d.created_at
                 OR (d.status <> 'draft' AND (i.content <> d.content OR i.description <> d.description OR ISNULL(i.compat, '') <> ISNULL(d.compat, '') OR ISNULL(i.origin, '') <> ISNULL(d.origin, ''))))
    THROW 50020, 'only a draft baseline version can be edited', 1;
  IF EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.id = i.id
              WHERE i.status <> d.status
                AND NOT ((d.status = 'draft' AND i.status = 'pending') OR (d.status = 'pending' AND i.status IN ('draft', 'approved', 'rejected')) OR (d.status = 'approved' AND i.status = 'superseded')))
    THROW 50021, 'that change of state is not allowed for a baseline version', 1;
END
GO
-- A baseline version is never deleted, except with the baseline of a client, site or cabinet that no longer exists at all (the simulated
-- fleet of demo mode is deleted for real; a real client or site is only ever marked removed, so a real baseline can never be deleted).
CREATE TRIGGER baseline_versions_never_deleted ON baseline_versions AFTER DELETE AS
BEGIN
  IF @@ROWCOUNT = 0 RETURN;
  SET NOCOUNT ON;
  IF EXISTS (SELECT 1 FROM deleted d JOIN baselines b ON b.id = d.baseline_id
              WHERE NOT ((b.scope_kind = 'client' AND NOT EXISTS (SELECT 1 FROM clients x WHERE x.id = TRY_CAST(b.scope_id AS uniqueidentifier)))
                      OR (b.scope_kind = 'site' AND NOT EXISTS (SELECT 1 FROM sites x WHERE x.id = TRY_CAST(b.scope_id AS uniqueidentifier)))
                      OR (b.scope_kind = 'cabinet' AND NOT EXISTS (SELECT 1 FROM cabinets x WHERE x.id = TRY_CAST(b.scope_id AS uniqueidentifier)))))
    THROW 50022, 'baseline versions are never deleted', 1;
END
GO
CREATE TRIGGER baselines_never_deleted ON baselines AFTER DELETE AS
BEGIN
  IF @@ROWCOUNT = 0 RETURN;
  SET NOCOUNT ON;
  IF EXISTS (SELECT 1 FROM deleted b
              WHERE NOT ((b.scope_kind = 'client' AND NOT EXISTS (SELECT 1 FROM clients x WHERE x.id = TRY_CAST(b.scope_id AS uniqueidentifier)))
                      OR (b.scope_kind = 'site' AND NOT EXISTS (SELECT 1 FROM sites x WHERE x.id = TRY_CAST(b.scope_id AS uniqueidentifier)))
                      OR (b.scope_kind = 'cabinet' AND NOT EXISTS (SELECT 1 FROM cabinets x WHERE x.id = TRY_CAST(b.scope_id AS uniqueidentifier)))))
    THROW 50023, 'baselines are never deleted', 1;
END
GO

-- ---- Last known healthy, health, drift ------------------------------------------------------------------------------------------------------
-- A mark is stored when a cabinet is healthy and its configuration is not the one the last mark recorded: the version of each category in force.
CREATE TABLE healthy_marks (
  [id] bigint IDENTITY(1,1) NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [marked_at] datetime2(3) NOT NULL CONSTRAINT [healthy_marks_marked_default] DEFAULT SYSUTCDATETIME(),
  [versions] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL,
  [in_force] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL,
  CONSTRAINT [healthy_marks_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [healthy_marks_versions_json] CHECK (ISJSON([versions], VALUE) = 1),
  CONSTRAINT [healthy_marks_in_force_json] CHECK ([in_force] IS NULL OR ISJSON([in_force], VALUE) = 1)
);
GO
ALTER TABLE healthy_marks ADD CONSTRAINT [healthy_marks_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
GO
CREATE INDEX healthy_marks_by_cabinet ON healthy_marks ([cabinet_id], [id] DESC);
GO

-- last_mark_id has no foreign key (a second cascade path from cabinets is not allowed); the newest mark is never pruned.
CREATE TABLE cabinet_health (
  [cabinet_id] uniqueidentifier NOT NULL,
  [state] nvarchar(16) NOT NULL,
  [evaluated_at] datetime2(3) NOT NULL,
  [since] datetime2(3) NOT NULL,
  [reasons] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL,
  [last_healthy_at] datetime2(3) NULL,
  [last_mark_id] bigint NULL,
  [degraded_since] datetime2(3) NULL,
  CONSTRAINT [cabinet_health_pkey] PRIMARY KEY ([cabinet_id]),
  CONSTRAINT [cabinet_health_reasons_json] CHECK (ISJSON([reasons], VALUE) = 1),
  CONSTRAINT [cabinet_health_state_check] CHECK (state IN ('healthy', 'degraded', 'offline', 'unknown'))
);
GO
ALTER TABLE cabinet_health ADD CONSTRAINT [cabinet_health_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
GO
CREATE INDEX cabinet_health_evaluated ON cabinet_health ([evaluated_at]);
GO

-- Where the cabinet differs from the baseline in force, item and field ('' when the whole item is missing or must not exist).
-- expected and actual hold any JSON value (text, number, true or false, a list), so the service reads them with its own parser.
CREATE TABLE cabinet_drift (
  [cabinet_id] uniqueidentifier NOT NULL,
  [category] nvarchar(16) NOT NULL,
  [item_key] nvarchar(200) NOT NULL,
  [field] nvarchar(32) NOT NULL,
  [mode] nvarchar(8) NOT NULL,
  [expected] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL,
  [actual] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL,
  [origin] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL,
  [severity] nvarchar(8) NOT NULL,
  [required] bit NOT NULL CONSTRAINT [cabinet_drift_required_default] DEFAULT 0,
  [first_seen] datetime2(3) NOT NULL,
  [last_seen] datetime2(3) NOT NULL,
  CONSTRAINT [cabinet_drift_pkey] PRIMARY KEY ([cabinet_id], [category], [item_key], [field]),
  CONSTRAINT [cabinet_drift_expected_json] CHECK ([expected] IS NULL OR ISJSON([expected], VALUE) = 1),
  CONSTRAINT [cabinet_drift_actual_json] CHECK ([actual] IS NULL OR ISJSON([actual], VALUE) = 1),
  CONSTRAINT [cabinet_drift_origin_json] CHECK (ISJSON([origin], VALUE) = 1),
  CONSTRAINT [cabinet_drift_mode_check] CHECK (mode IN ('match', 'present', 'absent')),
  CONSTRAINT [cabinet_drift_severity_check] CHECK (severity IN ('minor', 'major'))
) WITH (DATA_COMPRESSION = PAGE);
GO
ALTER TABLE cabinet_drift ADD CONSTRAINT [cabinet_drift_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
GO
-- The fleet view counts cabinets per difference.
CREATE INDEX cabinet_drift_by_item ON cabinet_drift ([category], [item_key], [field]) INCLUDE ([cabinet_id], [severity]) WITH (DATA_COMPRESSION = PAGE);
GO

-- Health transitions, for the timeline: when a cabinet went from healthy to not, and back.
CREATE TABLE health_transitions (
  [id] bigint IDENTITY(1,1) NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [at] datetime2(3) NOT NULL,
  [from_state] nvarchar(16) NULL,
  [to_state] nvarchar(16) NOT NULL,
  [reasons] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL,
  CONSTRAINT [health_transitions_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [health_transitions_reasons_json] CHECK (ISJSON([reasons], VALUE) = 1),
  CONSTRAINT [health_transitions_to_check] CHECK (to_state IN ('healthy', 'degraded', 'offline', 'unknown'))
) WITH (DATA_COMPRESSION = PAGE);
GO
ALTER TABLE health_transitions ADD CONSTRAINT [health_transitions_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
GO
CREATE INDEX health_transitions_by_cabinet ON health_transitions ([cabinet_id], [at] DESC) WITH (DATA_COMPRESSION = PAGE);
GO

-- ---- Rights of the application's role -------------------------------------------------------------------------------------------------------
-- Baselines and their versions are history: DELETE is granted only for demo mode, and the triggers refuse it for anything but the baselines of a
-- client, site or cabinet that is gone (the owner too).
GRANT DELETE, INSERT, SELECT, UPDATE ON config_versions TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON config_current TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON config_changes TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON baselines TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON baseline_versions TO cabinet_app;
GRANT DELETE, INSERT, SELECT ON healthy_marks TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON cabinet_health TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON cabinet_drift TO cabinet_app;
GRANT DELETE, INSERT, SELECT ON health_transitions TO cabinet_app;
GO

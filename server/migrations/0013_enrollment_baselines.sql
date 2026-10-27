-- The baseline decision made when a cabinet is approved (docs/spec/15-baselines-and-config.md "Baselines at enrollment"). Every
-- approval says which baseline the cabinet is judged against: one already in force (inherited), an approved one attached to its
-- site (attach), or its own first full configuration report as the site's baseline draft (capture). A capture waits here until
-- the cabinet has reported every category a site baseline uses; the draft it makes is then reviewed and approved like any other.
--
-- One row per cabinet, removed with the cabinet. The users and baseline versions it names are kept by their own rules (never
-- deleted while referenced), so the columns are plain identifiers rather than foreign keys: the demo removes its users and
-- baselines in its own order.

CREATE TABLE enrollment_baselines (
  [cabinet_id] uniqueidentifier NOT NULL,
  [site_id] uniqueidentifier NOT NULL,
  [decision] nvarchar(16) NOT NULL,
  [decided_by] uniqueidentifier NOT NULL,
  [decided_at] datetime2(3) NOT NULL CONSTRAINT [enrollment_baselines_decided_default] DEFAULT SYSUTCDATETIME(),
  [attached_version_id] uniqueidentifier NULL,
  [capture_state] nvarchar(16) NULL,
  [draft_version_id] uniqueidentifier NULL,
  [drafted_at] datetime2(3) NULL,
  CONSTRAINT [enrollment_baselines_pkey] PRIMARY KEY ([cabinet_id]),
  CONSTRAINT [enrollment_baselines_decision_check] CHECK ([decision] IN ('inherited', 'attach', 'capture')),
  CONSTRAINT [enrollment_baselines_attach_check] CHECK (([decision] = 'attach' AND [attached_version_id] IS NOT NULL) OR ([decision] <> 'attach' AND [attached_version_id] IS NULL)),
  CONSTRAINT [enrollment_baselines_capture_check] CHECK (
    ([decision] <> 'capture' AND [capture_state] IS NULL AND [draft_version_id] IS NULL AND [drafted_at] IS NULL)
    OR ([decision] = 'capture' AND [capture_state] IN ('waiting', 'failed') AND [draft_version_id] IS NULL AND [drafted_at] IS NULL)
    OR ([decision] = 'capture' AND [capture_state] = 'drafted' AND [draft_version_id] IS NOT NULL AND [drafted_at] IS NOT NULL))
);
GO
ALTER TABLE enrollment_baselines ADD CONSTRAINT [enrollment_baselines_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
GO
-- The captures still waiting are looked up on every configuration upload of the cabinet, by its key; this finds the few waiting ones for a site.
CREATE INDEX enrollment_baselines_waiting ON enrollment_baselines ([site_id]) WHERE [capture_state] = 'waiting';
GO
GRANT DELETE, INSERT, SELECT, UPDATE ON enrollment_baselines TO cabinet_app;
GO

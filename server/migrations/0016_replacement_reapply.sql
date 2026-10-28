-- Re-applying a replaced cabinet's settings on its replacement (docs/spec/05-server-spec.md "Replacing a cabinet"). The approval that
-- says "this replaces <cabinet>" queues one re-apply; once the new agent has reported, the server plans the steps from what the old
-- cabinet last reported and what applies to the new one (firewall policy, time zone, the drawer address, a fixed DNS and address),
-- issues them one at a time in the approving Admin's name, and verifies each from what the cabinet reads back.
--
-- One row per new cabinet, removed with it. The approving user and the old cabinet are plain identifiers, kept by their own rules.

CREATE TABLE replacement_reapply (
  [cabinet_id] uniqueidentifier NOT NULL,
  [replaces_cabinet_id] uniqueidentifier NOT NULL,
  [approved_by] uniqueidentifier NOT NULL,
  [state] nvarchar(16) NOT NULL CONSTRAINT [replacement_reapply_state_default] DEFAULT 'waiting',
  [detail] nvarchar(300) NULL,
  [created_at] datetime2(3) NOT NULL CONSTRAINT [replacement_reapply_created_default] DEFAULT SYSUTCDATETIME(),
  [started_at] datetime2(3) NULL,
  [finished_at] datetime2(3) NULL,
  CONSTRAINT [replacement_reapply_pkey] PRIMARY KEY ([cabinet_id]),
  CONSTRAINT [replacement_reapply_state_check] CHECK ([state] IN ('waiting', 'running', 'done', 'stopped')),
  CONSTRAINT [replacement_reapply_detail_check] CHECK (LEN([detail]) <= 300)
);
GO
ALTER TABLE replacement_reapply ADD CONSTRAINT [replacement_reapply_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
GO
CREATE INDEX replacement_reapply_open ON replacement_reapply ([state]) WHERE [state] IN ('waiting', 'running');
GO

CREATE TABLE replacement_reapply_steps (
  [cabinet_id] uniqueidentifier NOT NULL,
  [position] int NOT NULL,
  [kind] nvarchar(16) NOT NULL,
  [operation] nvarchar(64) NOT NULL,
  [params] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL,
  [state] nvarchar(16) NOT NULL,
  [detail] nvarchar(300) NULL,
  [command_id] uniqueidentifier NULL,
  [updated_at] datetime2(3) NOT NULL CONSTRAINT [replacement_reapply_steps_updated_default] DEFAULT SYSUTCDATETIME(),
  CONSTRAINT [replacement_reapply_steps_pkey] PRIMARY KEY ([cabinet_id], [position]),
  CONSTRAINT [replacement_reapply_steps_kind_check] CHECK ([kind] IN ('firewall', 'time_zone', 'drawer', 'dns', 'address')),
  CONSTRAINT [replacement_reapply_steps_operation_check] CHECK ([operation] IN ('firewall.applyPolicy', 'time.setZone', 'network.setIp', 'network.setDns')),
  CONSTRAINT [replacement_reapply_steps_params_json] CHECK ([params] IS NULL OR ISJSON([params], VALUE) = 1),
  CONSTRAINT [replacement_reapply_steps_state_check] CHECK ([state] IN ('pending', 'issued', 'verified', 'not_verified', 'failed', 'skipped')),
  CONSTRAINT [replacement_reapply_steps_detail_check] CHECK (LEN([detail]) <= 300)
);
GO
ALTER TABLE replacement_reapply_steps ADD CONSTRAINT [replacement_reapply_steps_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES replacement_reapply([cabinet_id]) ON DELETE CASCADE;
GO
GRANT DELETE, INSERT, SELECT, UPDATE ON replacement_reapply TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON replacement_reapply_steps TO cabinet_app;
GO

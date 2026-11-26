-- Package rollouts on the rollout engine (plan item 2.12, decision-log D162): a rollout is of an agent release, as before, or of an
-- approved software-library package, which each cabinet of a batch reached is sent as a package.install command. An agent rollout
-- keeps its version and architecture; a package rollout names its package and has neither. One rollout of each kind can be active at
-- a time, so a package can roll out while an agent release does. Each package target keeps the command it was sent.
DROP INDEX [rollouts_one_active] ON rollouts;
GO
ALTER TABLE rollouts DROP COLUMN [active_key];
GO
ALTER TABLE rollouts DROP CONSTRAINT [rollouts_version_fkey];
GO
ALTER TABLE rollouts ALTER COLUMN [version] nvarchar(450) NULL;
GO
ALTER TABLE rollouts ALTER COLUMN [architecture] nvarchar(16) NULL;
GO
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_version_fkey] FOREIGN KEY ([version], [architecture]) REFERENCES agent_releases([version], [architecture]);
GO
ALTER TABLE rollouts ADD [kind] nvarchar(16) NOT NULL CONSTRAINT [rollouts_kind_default] DEFAULT N'agent',
                         [package_id] uniqueidentifier NULL;
GO
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_kind_check] CHECK ([kind] IN ('agent', 'package'));
GO
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_package_fkey] FOREIGN KEY ([package_id]) REFERENCES packages([id]);
GO
-- An agent rollout names a release and no package; a package rollout names a package and no release.
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_kind_shape] CHECK (
  ([kind] = 'agent' AND [version] IS NOT NULL AND [architecture] IS NOT NULL AND [package_id] IS NULL)
  OR ([kind] = 'package' AND [package_id] IS NOT NULL AND [version] IS NULL AND [architecture] IS NULL));
GO
ALTER TABLE rollouts ADD [active_key] AS CAST(CASE WHEN state IN ('running', 'paused') THEN N'active:' + [kind] ELSE CONVERT(nvarchar(36), id) END AS nvarchar(36)) PERSISTED;
GO
CREATE UNIQUE INDEX rollouts_one_active ON rollouts ([active_key]);
GO
ALTER TABLE rollout_targets ADD [command_id] uniqueidentifier NULL;
GO
CREATE INDEX rollout_targets_command ON rollout_targets ([command_id]) WHERE [command_id] IS NOT NULL;
GO

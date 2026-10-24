-- Which Windows a release's programs are built for (docs/platform/second-architecture.md). A release becomes one version for
-- one architecture, and the rollout that offers it names the same pair: Windows cannot run a 64-bit program on 32-bit
-- Windows, so the store has to know which of the two a package is before it can be handed to a cabinet.
--
-- The architecture is deliberately NOT a field of the signed upgrade manifest. That schema is closed
-- (additionalProperties: false) and every already-installed agent validates the manifest with the copy of the schema it was
-- built with, so an added field would make the whole fleet refuse a manifest it should have accepted. The architecture lives
-- on this record - declared when the release is added, verified against the package's own bytes when the package arrives -
-- and inside the package itself, in the PE headers of its programs.
--
-- Every existing row was built for 64-bit Windows, the only architecture there was, so the backfill is exact and the column
-- can be made NOT NULL. The check repeats the schema's enum, and nothing else may be stored.

ALTER TABLE agent_releases ADD [architecture] nvarchar(16) NULL;
GO
UPDATE agent_releases SET [architecture] = N'windows-x64' WHERE [architecture] IS NULL;
GO
ALTER TABLE agent_releases ALTER COLUMN [architecture] nvarchar(16) NOT NULL;
GO
ALTER TABLE agent_releases ADD CONSTRAINT [agent_releases_architecture_check] CHECK ([architecture] IN ('windows-x64', 'windows-x86'));
GO

ALTER TABLE rollouts ADD [architecture] nvarchar(16) NULL;
GO
UPDATE rollouts SET [architecture] = N'windows-x64' WHERE [architecture] IS NULL;
GO
ALTER TABLE rollouts ALTER COLUMN [architecture] nvarchar(16) NOT NULL;
GO
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_architecture_check] CHECK ([architecture] IN ('windows-x64', 'windows-x86'));
GO

-- The foreign key is dropped before the key it points at, and both are put back naming the pair: a rollout can never point at
-- a version that exists only for the other architecture.
ALTER TABLE rollouts DROP CONSTRAINT [rollouts_version_fkey];
GO
-- The version alone stops being the key: the same version exists once per architecture.
ALTER TABLE agent_releases DROP CONSTRAINT [agent_releases_pkey];
GO
ALTER TABLE agent_releases ADD CONSTRAINT [agent_releases_pkey] PRIMARY KEY ([version], [architecture]);
GO
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_version_fkey] FOREIGN KEY ([version], [architecture]) REFERENCES agent_releases([version], [architecture]);
GO

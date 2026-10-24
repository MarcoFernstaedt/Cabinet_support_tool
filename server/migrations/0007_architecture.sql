-- Which Windows the agent programs on this cabinet are built for (docs/platform/second-architecture.md). Windows cannot run a
-- 64-bit program on 32-bit Windows, so a cabinet is approved, and later updated, as the architecture it can run: its installer
-- reports it, its heartbeat repeats it, and a rollout offers a release only to cabinets of the same one.
--
-- NULL until a cabinet says so: an agent built before the second architecture never reports one and is win-x64, so it keeps
-- being offered updates as before. The check repeats the schema's enum, and nothing else may be stored.

ALTER TABLE cabinets ADD [architecture] nvarchar(16) NULL;
GO
ALTER TABLE cabinets ADD CONSTRAINT [cabinets_architecture_check] CHECK ([architecture] IS NULL OR [architecture] IN ('windows-x64', 'windows-x86'));
GO

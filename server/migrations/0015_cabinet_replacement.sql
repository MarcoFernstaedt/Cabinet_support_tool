-- A cabinet that replaces another (docs/spec/05-server-spec.md "Replacing a cabinet"): when a drive fails and the agent is installed
-- again, the new enrollment is approved as "this replaces <cabinet>". The old cabinet is retired with its history kept on its own
-- record; the new one takes its place and its settings.
--
--   replaces_cabinet_id   On the new cabinet: the cabinet it replaced. At most one replacement per cabinet. The old cabinet's
--                         "replaced by" is read back through this column, so the link lives in one place.
ALTER TABLE cabinets ADD [replaces_cabinet_id] uniqueidentifier NULL;
GO
ALTER TABLE cabinets ADD CONSTRAINT [cabinets_replaces_fkey] FOREIGN KEY ([replaces_cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE cabinets ADD CONSTRAINT [cabinets_replaces_not_self] CHECK ([replaces_cabinet_id] IS NULL OR [replaces_cabinet_id] <> [id]);
GO
CREATE UNIQUE INDEX cabinets_replaces_once ON cabinets ([replaces_cabinet_id]) WHERE [replaces_cabinet_id] IS NOT NULL;
GO

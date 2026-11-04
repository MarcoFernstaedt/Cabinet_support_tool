-- Crash incidents (decision-log D21): one open incident per cabinet from the crash-incidents module. The reconcile that opens it can
-- run at the same moment from two event batches; this index makes the second open fail, and that run then adds to the incident the
-- first one opened. An incident's closed_at is set exactly when it is resolved or unresolved (incidents_closed_check).
CREATE UNIQUE INDEX incidents_one_open_crash ON incidents ([cabinet_id]) WHERE [closed_at] IS NULL AND [module_id] = N'crash-incidents';
GO

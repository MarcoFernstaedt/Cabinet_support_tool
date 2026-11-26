-- Rollouts with a target, a canary and batches (plan item 2.11, decision-log D161): a rollout can be for a client, a site or chosen
-- cabinets, and its batches after the canary can be set by the person who starts it, so a rollout holds up to ten batches instead of
-- four. Its plan (the target, and each batch's label and size) is kept with it for the console and the audit. A rollout from before
-- this change has no plan and keeps its four fixed batches.
ALTER TABLE rollouts DROP CONSTRAINT [rollouts_current_batch_check];
GO
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_current_batch_check] CHECK ([current_batch] >= 1 AND [current_batch] <= 10);
GO
ALTER TABLE rollout_targets DROP CONSTRAINT [rollout_targets_batch_check];
GO
ALTER TABLE rollout_targets ADD CONSTRAINT [rollout_targets_batch_check] CHECK ([batch] >= 1 AND [batch] <= 10);
GO
ALTER TABLE rollouts ADD [plan] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL;
GO
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_plan_json] CHECK ([plan] IS NULL OR (ISJSON([plan], OBJECT) = 1 AND DATALENGTH([plan]) <= 65536));
GO

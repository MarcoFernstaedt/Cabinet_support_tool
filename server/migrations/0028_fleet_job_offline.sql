-- A fleet job's cabinet that was out of contact for the whole job is "offline", not "failed" (finding F18.R2, decision-log D46): it never
-- took the command, so nothing was tried on it, and the next step differs (bring it back, then run the job again for it) from a cabinet
-- that tried and failed.
ALTER TABLE fleet_job_targets DROP CONSTRAINT [fleet_job_targets_state_check];
GO
ALTER TABLE fleet_job_targets ADD CONSTRAINT [fleet_job_targets_state_check]
  CHECK (state IN ('pending', 'skipped', 'issued', 'succeeded', 'failed', 'verified', 'not_verified', 'cancelled', 'offline'));
GO

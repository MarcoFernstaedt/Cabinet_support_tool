-- Fleet operations (docs/spec/13-roadmap.md modules 21 and 45): one fixed operation on chosen cabinets, run as a job.
-- The target list is fixed when the job starts (a snapshot: later changes to the fleet do not change it), each cabinet's
-- parameters are filled in by the server then, and each cabinet's outcome is recorded: skipped (with why), its command,
-- succeeded or failed, then verified (the cabinet's next report shows the change) or not verified.
CREATE TABLE fleet_jobs (
  id           uuid PRIMARY KEY,
  operation    text NOT NULL CHECK (operation IN ('time.setZone', 'time.sync', 'firewall.applyPolicy')),
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  batch_size   integer NOT NULL CHECK (batch_size BETWEEN 1 AND 50),
  total        integer NOT NULL CHECK (total BETWEEN 1 AND 200),
  state        text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'cancelled')),
  cancelled_by uuid REFERENCES users (id),
  finished_at  timestamptz
);
CREATE INDEX fleet_jobs_recent ON fleet_jobs (created_at DESC);

CREATE TABLE fleet_job_targets (
  job_id      uuid NOT NULL REFERENCES fleet_jobs (id),
  cabinet_id  uuid NOT NULL REFERENCES cabinets (id),
  position    integer NOT NULL,
  params      jsonb,
  state       text NOT NULL CHECK (state IN ('pending', 'skipped', 'issued', 'succeeded', 'failed', 'verified', 'not_verified', 'cancelled')),
  command_id  uuid REFERENCES commands (id),
  detail      text CHECK (length(detail) <= 300),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, cabinet_id)
);
CREATE INDEX fleet_job_targets_order ON fleet_job_targets (job_id, position);

-- DELETE only so turning demo mode off can remove jobs on simulated cabinets (src/demo/demo.ts).
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_jobs, fleet_job_targets TO cabinet_app;

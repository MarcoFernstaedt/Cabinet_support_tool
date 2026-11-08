-- One writer per background job across server instances (finding F21.R1, decision-log D49). Inside one host the primary process already
-- runs the jobs alone (main.ts); two instances on two hosts would both run every job. Each job is leased by name: an instance runs it
-- only while it holds the lease, renews it each run, and another takes it over once a holder has stopped renewing (its lease ran out).
CREATE TABLE job_leases (
  [name] nvarchar(64) NOT NULL,
  [holder] nvarchar(64) NOT NULL,
  [until] datetime2(3) NOT NULL,
  [taken_at] datetime2(3) NOT NULL CONSTRAINT [job_leases_taken_default] DEFAULT SYSUTCDATETIME(),
  CONSTRAINT [job_leases_pkey] PRIMARY KEY ([name])
);
GO
GRANT INSERT, SELECT, UPDATE ON job_leases TO cabinet_app;
GO

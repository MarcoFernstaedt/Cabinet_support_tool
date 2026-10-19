-- Operations telemetry (docs/platform/operations.md): hourly counters the server keeps about itself. Counts only: a kind, a short
-- code from a fixed vocabulary (a route pattern, an error class, a status), and a number. No message text, no identifiers, no payloads.
-- Kept 90 days; pruned by the nightly retention job.
CREATE TABLE ops_counters (
  [hour] datetime2(0) NOT NULL,
  [kind] varchar(32) NOT NULL,
  [code] varchar(80) NOT NULL,
  [count] bigint NOT NULL,
  CONSTRAINT [ops_counters_pkey] PRIMARY KEY ([hour], [kind], [code]),
  CONSTRAINT [ops_counters_count_check] CHECK ([count] >= 0)
) WITH (DATA_COMPRESSION = PAGE);
GO

-- Operations alerts use the security alert mechanism (one open alert per signature), so the kinds are widened.
ALTER TABLE security_alerts DROP CONSTRAINT [security_alerts_kind_check];
GO
ALTER TABLE security_alerts ADD CONSTRAINT [security_alerts_kind_check] CHECK (kind IN ('write_volume', 'failed_logins', 'failed_step_ups', 'new_location', 'new_device',
  'audit_chain', 'agent_self_check', 'package_refused', 'signature_failure', 'certificate',
  'ops_database', 'ops_disk', 'ops_backup', 'ops_errors', 'ops_shed', 'ops_migration', 'ops_ca'));
GO

GRANT DELETE, INSERT, SELECT, UPDATE ON ops_counters TO cabinet_app;
GO

-- Clearing the old events' JSON frees space inside the pages of the clustered index; REORGANIZE compacts them and releases the empty pages.
-- The application's account may not alter tables, so the nightly job calls this procedure, which runs as the database owner and does only this.
CREATE PROCEDURE reorganize_events WITH EXECUTE AS OWNER AS
BEGIN
  SET NOCOUNT ON;
  ALTER INDEX events_seq ON events REORGANIZE;
END;
GO

GRANT EXECUTE ON reorganize_events TO cabinet_app;
GO

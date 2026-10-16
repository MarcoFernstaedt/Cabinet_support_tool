-- The latest stored answer of a read, per cabinet and operation: for "last known" on an offline cabinet and for searching the fleet.
CREATE INDEX commands_latest_result ON commands (cabinet_id, operation, result_at DESC) WHERE status = 'succeeded' AND result IS NOT NULL;
CREATE INDEX commands_result_by_operation ON commands (operation, cabinet_id, result_at DESC) WHERE status = 'succeeded' AND result IS NOT NULL;

-- A load sample from a cabinet's heartbeat, at most one every five minutes, kept for 14 days: the trend charts.
CREATE TABLE health_samples (
  cabinet_id           uuid NOT NULL REFERENCES cabinets(id) ON DELETE CASCADE,
  at                   timestamptz NOT NULL,
  cpu_percent          smallint NOT NULL CHECK (cpu_percent BETWEEN 0 AND 100),
  memory_used_percent  smallint NOT NULL CHECK (memory_used_percent BETWEEN 0 AND 100),
  disk_free_percent    smallint NOT NULL CHECK (disk_free_percent BETWEEN 0 AND 100),
  PRIMARY KEY (cabinet_id, at)
);

GRANT SELECT, INSERT, DELETE ON health_samples TO cabinet_app;

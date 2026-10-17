-- Each drive's own health report, kept so a drive that is getting worse can be seen before it fails. At most one per drive every 12 hours, kept 400 days.
CREATE TABLE drive_samples (
  cabinet_id      uuid NOT NULL REFERENCES cabinets(id) ON DELETE CASCADE,
  drive_key       text NOT NULL CHECK (length(drive_key) BETWEEN 1 AND 256),
  at              timestamptz NOT NULL,
  model           text,
  serial_number   text,
  health          text NOT NULL CHECK (health IN ('healthy', 'warning', 'failing', 'unknown')),
  predict_failure boolean,
  temperature_c   integer,
  power_on_hours  bigint,
  reallocated     bigint,
  pending         bigint,
  uncorrectable   bigint,
  wear_percent    integer,
  PRIMARY KEY (cabinet_id, drive_key, at)
);

-- What the history says about each drive now, so the fleet view needs no recalculation and an alert is raised only when the level rises.
CREATE TABLE drive_status (
  cabinet_id     uuid NOT NULL REFERENCES cabinets(id) ON DELETE CASCADE,
  drive_key      text NOT NULL,
  model          text,
  level          text NOT NULL CHECK (level IN ('ok', 'watch', 'act', 'urgent')),
  reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  projection     jsonb NOT NULL DEFAULT '{}'::jsonb,
  assessed_at    timestamptz NOT NULL,
  PRIMARY KEY (cabinet_id, drive_key)
);
CREATE INDEX drive_status_level ON drive_status (level) WHERE level <> 'ok';

GRANT SELECT, INSERT, UPDATE, DELETE ON drive_samples, drive_status TO cabinet_app;

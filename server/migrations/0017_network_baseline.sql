-- Network troubleshooting: what each site's network should look like (the baseline), diagnoses run on many cabinets at once,
-- network fixes as fleet jobs, and the simulated cabinets' own network state (so a fix made on one really takes effect).
ALTER TABLE sites ADD COLUMN network_baseline jsonb;
ALTER TABLE cabinets ADD COLUMN demo_net jsonb;

CREATE TABLE diagnosis_batches (
  id          uuid PRIMARY KEY,
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  site_id     uuid REFERENCES sites (id),
  cabinet_ids uuid[] NOT NULL,
  total       integer NOT NULL CHECK (total BETWEEN 1 AND 60)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON diagnosis_batches TO cabinet_app;

ALTER TABLE diagnoses ADD COLUMN batch_id uuid REFERENCES diagnosis_batches (id);
CREATE INDEX diagnoses_batch ON diagnoses (batch_id) WHERE batch_id IS NOT NULL;
ALTER TABLE diagnoses DROP CONSTRAINT diagnoses_state_check;
ALTER TABLE diagnoses ADD CONSTRAINT diagnoses_state_check CHECK (state IN ('running', 'done', 'failed', 'offline'));

ALTER TABLE fleet_jobs DROP CONSTRAINT fleet_jobs_operation_check;
ALTER TABLE fleet_jobs ADD CONSTRAINT fleet_jobs_operation_check
  CHECK (operation IN ('time.setZone', 'time.sync', 'firewall.applyPolicy', 'network.setDns', 'network.setIp'));

INSERT INTO issue_types (id, key, name, severity, description, built_in) VALUES
  ('00000000-0000-4000-8000-000000000121', 'network_baseline', 'Network settings differ from the site baseline', 'minor',
   'A network diagnosis found this cabinet''s address, gateway or DNS servers different from what the site''s baseline says they should be. Open the diagnosis: it shows what differs and offers the fix.', true);

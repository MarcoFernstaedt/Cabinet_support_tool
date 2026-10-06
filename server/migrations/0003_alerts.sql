-- Milestone 4: issue types, symptom rules with their history, and alerts
-- (docs/spec/05-server-spec.md "Issue types and symptom rules" and "Alerts engine").

CREATE TABLE issue_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text UNIQUE,              -- set only on the built-in types the engine refers to
  name         text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 128),
  severity     text NOT NULL CHECK (severity IN ('major', 'minor')),
  description  text NOT NULL CHECK (length(description) <= 1024),
  built_in     boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO issue_types (id, key, name, severity, description, built_in) VALUES
  ('00000000-0000-4000-8000-000000000101', 'scanner',  'Fingerprint scanner problem', 'major', 'The fingerprint scanner is disconnected, has no driver, or Windows reports a device error.', true),
  ('00000000-0000-4000-8000-000000000102', 'drive',    'Drive failing',               'major', 'The drive predicts failure or shows early signs of wear. Plan a replacement before it fails.', true),
  ('00000000-0000-4000-8000-000000000103', 'driver',   'Driver failure',              'minor', 'A driver failed to load or start.', true),
  ('00000000-0000-4000-8000-000000000104', 'network',  'Network connectivity',        'major', 'The cabinet is losing its network, DNS or connection to the sync cabinet.', true),
  ('00000000-0000-4000-8000-000000000105', 'firewall', 'Unexpected firewall change',  'major', 'The firewall changed outside the platform.', true),
  ('00000000-0000-4000-8000-000000000106', 'update',   'Windows update failure',      'minor', 'Windows Update failed to install an update.', true),
  ('00000000-0000-4000-8000-000000000107', 'agent',    'Agent problem',               'minor', 'The cabinet agent reported a problem with itself.', true),
  ('00000000-0000-4000-8000-000000000108', 'offline',  'Cabinet offline',             'minor', 'The cabinet has not been heard from for longer than the offline alert threshold.', true);

CREATE TABLE symptom_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_type_id  uuid REFERENCES issue_types(id),
  kind           text NOT NULL CHECK (kind IN ('map', 'suppress')),
  state          text NOT NULL CHECK (state IN ('proposed', 'live', 'disabled', 'expired', 'rejected')),
  version        integer NOT NULL DEFAULT 1,
  match          jsonb NOT NULL,           -- the symptomMatch contract; checked against it before it is stored
  regroup        boolean NOT NULL DEFAULT false,
  built_in       boolean NOT NULL DEFAULT false,
  proposed_by    uuid REFERENCES users(id),
  approved_by    uuid REFERENCES users(id),
  reason         text,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  matched_count  bigint NOT NULL DEFAULT 0,
  CHECK ((kind = 'map') = (issue_type_id IS NOT NULL))
);
CREATE INDEX symptom_rules_state ON symptom_rules (state);

-- Every version of every rule, and who did what to it.
CREATE TABLE symptom_rule_history (
  id             bigserial PRIMARY KEY,
  rule_id        uuid NOT NULL REFERENCES symptom_rules(id),
  version        integer NOT NULL,
  change         text NOT NULL CHECK (change IN ('created', 'proposed', 'approved', 'rejected', 'disabled', 'rolled_back', 'expired')),
  state          text NOT NULL,
  issue_type_id  uuid,
  match          jsonb NOT NULL,
  changed_by     uuid REFERENCES users(id),
  changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX symptom_rule_history_rule ON symptom_rule_history (rule_id, id);

INSERT INTO symptom_rules (id, issue_type_id, kind, state, match, built_in) VALUES
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'map', 'live', '{"kind": "scanner"}', true),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind": "smart_warning"}', true),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000105', 'map', 'live', '{"kind": "firewall_changed"}', true);
INSERT INTO symptom_rule_history (rule_id, version, change, state, issue_type_id, match)
  SELECT id, 1, 'created', state, issue_type_id, match FROM symptom_rules;

CREATE TABLE alerts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id     uuid NOT NULL REFERENCES cabinets(id),
  issue_type_id  uuid REFERENCES issue_types(id),   -- null for an unrecognized error
  severity       text NOT NULL CHECK (severity IN ('major', 'minor')),
  signature      text NOT NULL,                     -- what folds repeats together: the issue, or log|source|event ID
  title          text NOT NULL,
  state          text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'claimed', 'resolved')),
  occurrences    integer NOT NULL DEFAULT 1,
  first_seen     timestamptz NOT NULL,
  last_seen      timestamptz NOT NULL,
  site_pattern   boolean NOT NULL DEFAULT false,
  rule_id        uuid REFERENCES symptom_rules(id),
  last_event_id  uuid,
  claimed_by     uuid REFERENCES users(id),
  claimed_at     timestamptz,
  resolved_by    uuid REFERENCES users(id),        -- null with a resolved state means it resolved itself
  resolved_at    timestamptz,
  resolution     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Correlation: one alert per issue (or unrecognized signature) per cabinet until it is resolved.
CREATE UNIQUE INDEX alerts_one_active ON alerts (cabinet_id, signature) WHERE state <> 'resolved';
CREATE INDEX alerts_state_severity ON alerts (state, severity, last_seen DESC);
CREATE INDEX alerts_issue_recent ON alerts (issue_type_id, last_seen DESC);

ALTER TABLE events ADD COLUMN device jsonb, ADD COLUMN alert_id uuid REFERENCES alerts(id);
CREATE INDEX events_received ON events (occurred_at DESC);
CREATE INDEX events_alert ON events (alert_id);

-- New alerts, claims and resolutions wake every console's live stream.
CREATE FUNCTION alert_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('alerts', NEW.id::text || ' created');
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM pg_notify('alerts', NEW.id::text || ' ' || NEW.state);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_notify AFTER INSERT OR UPDATE OF state ON alerts FOR EACH ROW EXECUTE FUNCTION alert_notify();

GRANT SELECT, INSERT, UPDATE ON issue_types, symptom_rules, alerts TO cabinet_app;
GRANT SELECT, INSERT ON symptom_rule_history TO cabinet_app;
GRANT USAGE ON SEQUENCE symptom_rule_history_id_seq TO cabinet_app;

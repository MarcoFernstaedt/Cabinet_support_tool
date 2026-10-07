-- Milestone 6: administration and monitoring (docs/spec/05-server-spec.md "Security alerts",
-- "Presence", "Accounts", "Retention"; docs/spec/06-console-spec.md "Admin screens").

-- A deleted account keeps its history (commands, audit entries) but can never sign in again.
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled', 'deleted'));

-- Removing a client or site keeps its history (its removed cabinets, their commands and audit entries);
-- it is allowed only when no active or pending cabinet is left in it. A removed name can be used again.
ALTER TABLE clients ADD COLUMN removed_at timestamptz;
ALTER TABLE sites ADD COLUMN removed_at timestamptz;
ALTER TABLE clients DROP CONSTRAINT clients_name_key;
ALTER TABLE sites DROP CONSTRAINT sites_client_id_name_key;
CREATE UNIQUE INDEX clients_live_name ON clients (name) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX sites_live_name ON sites (client_id, name) WHERE removed_at IS NULL;

-- A suppression is renewed for another 90 days instead of expiring; the renewal is part of its history.
ALTER TABLE symptom_rule_history DROP CONSTRAINT symptom_rule_history_change_check;
ALTER TABLE symptom_rule_history ADD CONSTRAINT symptom_rule_history_change_check
  CHECK (change IN ('created', 'proposed', 'approved', 'rejected', 'disabled', 'rolled_back', 'expired', 'renewed'));

-- The networks each account has signed in from, so a sign-in from a new one raises a security alert.
-- A network is an IPv4 /24 or an IPv6 /64, so a changing address on the same network is not "new".
CREATE TABLE user_networks (
  user_id     uuid NOT NULL REFERENCES users(id),
  network     text NOT NULL CHECK (length(network) BETWEEN 1 AND 64),
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, network)
);

-- Security alerts go to Admins only. Repeats of the same alert fold into one open alert, so a flood
-- (someone trying certificates or passwords from the internet) is one alert with a count, not thousands.
CREATE TABLE security_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('write_volume', 'failed_logins', 'failed_step_ups', 'new_location', 'audit_chain',
                                             'agent_self_check', 'package_refused', 'signature_failure', 'certificate')),
  signature    text NOT NULL CHECK (length(signature) BETWEEN 1 AND 256),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  detail       jsonb NOT NULL DEFAULT '{}',
  user_id      uuid REFERENCES users(id),
  cabinet_id   uuid REFERENCES cabinets(id),
  state        text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  occurrences  integer NOT NULL DEFAULT 1,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  resolution   text,
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX security_alerts_open_signature ON security_alerts (signature) WHERE state = 'open';
CREATE INDEX security_alerts_recent ON security_alerts (last_seen DESC);

-- The audit log viewer searches by person, cabinet, action and date.
CREATE INDEX audit_log_actor ON audit_log (actor_id, seq DESC);
CREATE INDEX audit_log_target ON audit_log (target_id, seq DESC);
CREATE INDEX audit_log_action ON audit_log (action, seq DESC);
CREATE INDEX audit_log_at ON audit_log (at);

-- Retention removes old events, alerts and firewall history, and clears old command results
-- (the command itself, who sent it and when, stays). The audit log is never pruned.
GRANT SELECT, INSERT, UPDATE ON user_networks, security_alerts TO cabinet_app;
GRANT DELETE ON alerts, firewall_changes TO cabinet_app;

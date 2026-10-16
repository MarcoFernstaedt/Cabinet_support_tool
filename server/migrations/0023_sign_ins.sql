-- Sign-ins people can see: every password that was accepted, from which network and device, and whether either was new.
-- A device is a random value kept in a cookie on the browser; only its hash is stored. The first device an account ever uses is not "new".
CREATE TABLE user_devices (
  user_id      uuid NOT NULL REFERENCES users(id),
  device_hash  bytea NOT NULL,
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_hash)
);

CREATE TABLE sign_ins (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  at            timestamptz NOT NULL DEFAULT now(),
  address       text NOT NULL CHECK (length(address) BETWEEN 1 AND 64),
  network       text NOT NULL CHECK (length(network) BETWEEN 1 AND 64),
  device_label  text NOT NULL CHECK (length(device_label) BETWEEN 1 AND 120),
  new_network   boolean NOT NULL,
  new_device    boolean NOT NULL,
  completed     boolean NOT NULL DEFAULT false
);
CREATE INDEX sign_ins_user_at ON sign_ins (user_id, at DESC);
CREATE INDEX sign_ins_new ON sign_ins (at DESC) WHERE new_network OR new_device;

ALTER TABLE sessions ADD COLUMN sign_in_id bigint REFERENCES sign_ins(id);

ALTER TABLE security_alerts DROP CONSTRAINT security_alerts_kind_check;
ALTER TABLE security_alerts ADD CONSTRAINT security_alerts_kind_check CHECK (kind IN ('write_volume', 'failed_logins', 'failed_step_ups', 'new_location', 'new_device',
  'audit_chain', 'agent_self_check', 'package_refused', 'signature_failure', 'certificate'));

GRANT SELECT, INSERT, UPDATE ON user_devices, sign_ins TO cabinet_app;
GRANT USAGE ON SEQUENCE sign_ins_id_seq TO cabinet_app;

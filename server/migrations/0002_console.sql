-- Milestone 3: staff sign-in, sessions, step-up, and console-managed settings
-- (docs/spec/02-security-model.md controls 6 to 8; docs/spec/09-open-decisions.md).

ALTER TABLE users
  ADD COLUMN password_hash         text,
  ADD COLUMN must_change_password  boolean NOT NULL DEFAULT true,
  ADD COLUMN totp_secret_enc       bytea,
  ADD COLUMN totp_enabled          boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_last_step        bigint,
  ADD COLUMN failed_logins         integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until          timestamptz,
  ADD COLUMN last_login_at         timestamptz,
  ADD COLUMN write_limit           integer NOT NULL DEFAULT 20,
  ADD COLUMN tour_completed        boolean NOT NULL DEFAULT false;

-- Only a hash of the session ID is stored; the cookie holds the ID itself.
CREATE TABLE sessions (
  id_hash           bytea PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id),
  stage             text NOT NULL CHECK (stage IN ('totp', 'totp_setup', 'password_change', 'complete')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  address           text,
  current_cabinet   uuid
);
CREATE INDEX sessions_user ON sessions (user_id);

-- One-time tokens bound to one action on one target, valid 2 minutes.
CREATE TABLE step_up_tokens (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  action      text NOT NULL,
  target      text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- The site's sync cabinet, set in the console (agents accept it only on their own private network).
ALTER TABLE sites
  ADD COLUMN sync_address text CHECK (sync_address IS NULL OR sync_address ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'),
  ADD COLUMN sync_ports   integer[] NOT NULL DEFAULT '{}' CHECK (cardinality(sync_ports) <= 4);

-- A cabinet's own scanner hardware IDs, overriding the fleet default in settings('scanner.hardwareIds').
ALTER TABLE cabinets ADD COLUMN scanner_hardware_ids jsonb;

-- Command results wake the console's live stream for the person who issued the command.
CREATE FUNCTION command_result_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.result IS NOT NULL AND (OLD.result IS NULL) THEN
    PERFORM pg_notify('command_results', NEW.id::text || ' ' || NEW.issued_by::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER command_result_notify AFTER UPDATE OF result ON commands FOR EACH ROW EXECUTE FUNCTION command_result_notify();

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, step_up_tokens TO cabinet_app;

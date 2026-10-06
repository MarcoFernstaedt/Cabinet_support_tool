-- Milestone 2: the platform database (docs/spec/05-server-spec.md "Platform database").
-- Roles are group roles without login; deployments grant them to login accounts.
--   cabinet_app            the server's account: reads and writes the platform tables,
--                          cannot write the audit log except through audit_append().
--   cabinet_audit_writer   owns audit_append(); may only insert audit entries and advance the chain head.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cabinet_app') THEN CREATE ROLE cabinet_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cabinet_audit_writer') THEN CREATE ROLE cabinet_audit_writer NOLOGIN; END IF;
END $$;

CREATE TABLE users (
  id          uuid PRIMARY KEY,
  username    text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{2,64}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  role        text NOT NULL CHECK (role IN ('tier1', 'tier2', 'admin')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clients (
  id            uuid PRIMARY KEY,
  name          text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 128),
  write_paused  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  id          uuid PRIMARY KEY,
  client_id   uuid NOT NULL REFERENCES clients(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, name)
);

CREATE TABLE cabinets (
  id                  uuid PRIMARY KEY,
  site_id             uuid NOT NULL REFERENCES sites(id),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  role                text NOT NULL CHECK (role IN ('sync', 'satellite', 'standalone')),
  status              text NOT NULL CHECK (status IN ('pending', 'active', 'removed')),
  hostname            text,
  serial_number       text,
  read_only           boolean,
  agent_version       text,
  uptime_seconds      bigint,
  clock_skew_seconds  double precision,
  last_heartbeat_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, name)
);

-- Every certificate ever issued to a cabinet. A connection is accepted only
-- with a serial listed here, unrevoked, unexpired, for an active cabinet.
CREATE TABLE cabinet_certificates (
  serial      text PRIMARY KEY CHECK (serial ~ '^[0-9A-F]{2,64}$'),
  cabinet_id  uuid NOT NULL REFERENCES cabinets(id),
  issued_at   timestamptz NOT NULL DEFAULT now(),
  not_after   timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX cabinet_certificates_cabinet ON cabinet_certificates (cabinet_id);

-- Only a hash of each bootstrap token is stored; the token itself is shown once.
CREATE TABLE bootstrap_tokens (
  id          uuid PRIMARY KEY,
  token_hash  bytea NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE enrollment_requests (
  id                  uuid PRIMARY KEY,
  token_id            uuid NOT NULL UNIQUE REFERENCES bootstrap_tokens(id),
  csr                 text NOT NULL,
  fingerprints        jsonb NOT NULL,
  source_address      text,
  status              text NOT NULL CHECK (status IN ('pending', 'rejected', 'issued')),
  cabinet_id          uuid REFERENCES cabinets(id),
  certificate_serial  text REFERENCES cabinet_certificates(serial),
  certificate_pem     text,
  decided_by          uuid REFERENCES users(id),
  decided_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enrollment_requests_pending ON enrollment_requests (created_at) WHERE status = 'pending';

CREATE TABLE commands (
  id            uuid PRIMARY KEY,
  cabinet_id    uuid NOT NULL REFERENCES cabinets(id),
  operation     text NOT NULL,
  params        jsonb NOT NULL,
  issued_by     uuid NOT NULL REFERENCES users(id),
  issued_at     timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  status        text NOT NULL CHECK (status IN ('queued', 'delivered', 'succeeded', 'failed', 'rejected', 'expired')),
  delivered_at  timestamptz,
  result        jsonb,
  result_at     timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX commands_waiting ON commands (cabinet_id, issued_at) WHERE status = 'queued';

-- A new command wakes the long poll held for its cabinet, from any server process.
CREATE FUNCTION commands_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('cabinet_commands', NEW.cabinet_id::text);
  RETURN NEW;
END $$;
CREATE TRIGGER commands_notify AFTER INSERT ON commands FOR EACH ROW EXECUTE FUNCTION commands_notify();

CREATE TABLE events (
  event_id       uuid PRIMARY KEY,
  cabinet_id     uuid NOT NULL REFERENCES cabinets(id),
  kind           text NOT NULL,
  occurred_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  source         jsonb,
  command_id     uuid,
  severity_hint  text,
  detail         jsonb,
  matched_rule   uuid
);
CREATE INDEX events_cabinet_time ON events (cabinet_id, occurred_at DESC);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- Audit log: append-only hash chain -----------------------------------------
CREATE TABLE audit_log (
  seq          bigint PRIMARY KEY,
  at           timestamptz NOT NULL,
  actor_kind   text NOT NULL CHECK (actor_kind IN ('user', 'agent', 'system')),
  actor_id     text NOT NULL,
  action       text NOT NULL,
  target_kind  text,
  target_id    text,
  outcome      text NOT NULL,
  details      jsonb NOT NULL,
  prev_hash    text NOT NULL,
  hash         text NOT NULL
);

CREATE TABLE audit_chain_head (
  id    int PRIMARY KEY CHECK (id = 1),
  seq   bigint NOT NULL,
  hash  text NOT NULL
);
INSERT INTO audit_chain_head VALUES (1, 0, repeat('0', 64));

-- The exact text each entry's hash covers. Verification recomputes it from the stored row.
CREATE FUNCTION audit_hash_input(p_prev text, p_seq bigint, p_at timestamptz, p_actor_kind text, p_actor_id text, p_action text,
                                 p_target_kind text, p_target_id text, p_outcome text, p_details jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws(E'\x1f', p_prev, p_seq::text, to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                   p_actor_kind, p_actor_id, p_action, coalesce(p_target_kind, ''), coalesce(p_target_id, ''), p_outcome, p_details::text)
$$;

CREATE FUNCTION audit_append(p_actor_kind text, p_actor_id text, p_action text, p_target_kind text, p_target_id text,
                             p_outcome text, p_details jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  head audit_chain_head%ROWTYPE;
  now_at timestamptz := clock_timestamp();
  new_hash text;
BEGIN
  SELECT * INTO head FROM audit_chain_head WHERE id = 1 FOR UPDATE; -- serializes the chain
  new_hash := encode(sha256(convert_to(audit_hash_input(head.hash, head.seq + 1, now_at, p_actor_kind, p_actor_id, p_action,
                                                        p_target_kind, p_target_id, p_outcome, p_details), 'UTF8')), 'hex');
  INSERT INTO audit_log VALUES (head.seq + 1, now_at, p_actor_kind, p_actor_id, p_action, p_target_kind, p_target_id, p_outcome, p_details, head.hash, new_hash);
  UPDATE audit_chain_head SET seq = head.seq + 1, hash = new_hash WHERE id = 1;
  RETURN head.seq + 1;
END $$;

ALTER TABLE audit_log OWNER TO cabinet_audit_writer;
ALTER TABLE audit_chain_head OWNER TO cabinet_audit_writer;
ALTER FUNCTION audit_append(text, text, text, text, text, text, jsonb) OWNER TO cabinet_audit_writer;
REVOKE ALL ON audit_log, audit_chain_head FROM PUBLIC;
-- The writer may only insert entries (it reads and advances the head row to chain them).
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON audit_log FROM cabinet_audit_writer;
-- Owners keep implicit rights; this trigger makes the log append-only even for the owner.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the audit log is append-only';
END $$;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

REVOKE ALL ON FUNCTION audit_append(text, text, text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_append(text, text, text, text, text, text, jsonb) TO cabinet_app;
GRANT SELECT ON audit_log TO cabinet_app;  -- for viewing and chain verification; never written directly

GRANT SELECT, INSERT, UPDATE, DELETE ON users, clients, sites, cabinets, cabinet_certificates, bootstrap_tokens,
  enrollment_requests, commands, events, settings TO cabinet_app;

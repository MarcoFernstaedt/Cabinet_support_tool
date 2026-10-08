-- Milestone 7: signed agent upgrades (docs/spec/07-upgrade-channel.md).
-- The server stores releases and runs staged rollouts. It cannot make a release an agent will accept: every
-- release is signed by a key in the KMS that the server never holds, and every agent checks it again itself.

-- Batch 2 of every rollout: the cabinets in the office.
ALTER TABLE cabinets ADD COLUMN in_office boolean NOT NULL DEFAULT false;

-- The update store. The manifest is kept exactly as signed; the package zip is a read-only file named by version.
CREATE TABLE agent_releases (
  version          text PRIMARY KEY CHECK (version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-[0-9A-Za-z.-]{1,32})?$'),
  manifest         bytea NOT NULL CHECK (length(manifest) <= 4096),
  signature        jsonb NOT NULL,
  key_id           text NOT NULL,
  minimum_version  text NOT NULL,
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
  released_at      timestamptz NOT NULL,
  notes            text,
  state            text NOT NULL CHECK (state IN ('awaiting_package', 'ready', 'refused')),
  refusal          text,
  added_by         uuid NOT NULL REFERENCES users(id),
  added_at         timestamptz NOT NULL DEFAULT now(),
  package_at       timestamptz
);

-- Rollout: ID, version, batches, state, started by (docs/spec/05-server-spec.md).
CREATE TABLE rollouts (
  id                     uuid PRIMARY KEY,
  version                text NOT NULL REFERENCES agent_releases(version),
  state                  text NOT NULL CHECK (state IN ('running', 'paused', 'completed', 'stopped')),
  current_batch          integer NOT NULL CHECK (current_batch BETWEEN 1 AND 4),
  success_rate_percent   integer NOT NULL CHECK (success_rate_percent BETWEEN 50 AND 100),
  failure_limit_percent  integer NOT NULL CHECK (failure_limit_percent BETWEEN 0 AND 50),
  started_by             uuid NOT NULL REFERENCES users(id),
  started_at             timestamptz NOT NULL DEFAULT now(),
  batch_started_at       timestamptz NOT NULL DEFAULT now(),
  paused_reason          text,
  -- Failures in the current batch an Admin accepted by resuming; only failures after that count toward the limit.
  accepted_failures      integer NOT NULL DEFAULT 0,
  changed_by             uuid REFERENCES users(id),
  finished_at            timestamptz
);
-- One rollout at a time: a second can start only when the last one has completed or been stopped.
CREATE UNIQUE INDEX rollouts_one_active ON rollouts ((true)) WHERE state IN ('running', 'paused');

-- Each cabinet's place in a rollout and how its upgrade ended.
CREATE TABLE rollout_targets (
  rollout_id    uuid NOT NULL REFERENCES rollouts(id),
  cabinet_id    uuid NOT NULL REFERENCES cabinets(id),
  batch         integer NOT NULL CHECK (batch BETWEEN 1 AND 4),
  state         text NOT NULL CHECK (state IN ('pending', 'offered', 'succeeded', 'failed', 'skipped')),
  from_version  text,
  offered_at    timestamptz,
  finished_at   timestamptz,
  outcome       text CHECK (outcome IS NULL OR outcome IN ('succeeded', 'refused', 'rolled_back', 'failed', 'timed_out', 'offline')),
  check_name    text,
  message       text,
  PRIMARY KEY (rollout_id, cabinet_id)
);
CREATE INDEX rollout_targets_cabinet ON rollout_targets (cabinet_id, state);
CREATE INDEX rollout_targets_batch ON rollout_targets (rollout_id, batch, state);

GRANT SELECT, INSERT, UPDATE ON agent_releases, rollouts, rollout_targets TO cabinet_app;

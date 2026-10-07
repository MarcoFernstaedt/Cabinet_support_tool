-- Milestone 5: the software library, fleet safety controls for writes, and firewall history
-- (docs/spec/05-server-spec.md "Approved software library", "Fleet safety controls", "Firewall change attribution").

CREATE TABLE packages (
  id            uuid PRIMARY KEY,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  version       text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  vendor        text NOT NULL CHECK (length(vendor) BETWEEN 1 AND 128),
  type          text NOT NULL CHECK (type IN ('driver', 'msi')),
  hardware_ids  jsonb NOT NULL DEFAULT '[]',
  notes         text,
  state         text NOT NULL CHECK (state IN ('uploading', 'uploaded', 'approved', 'retired', 'refused')),
  sha256        text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes    bigint,
  signer        text,
  detail        text,
  refusal       text,
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  retired_by    uuid REFERENCES users(id),
  retired_at    timestamptz,
  -- The two-person rule: the uploader can never be the approver.
  CHECK (approved_by IS NULL OR approved_by <> uploaded_by),
  CHECK (state NOT IN ('uploaded', 'approved', 'retired') OR (sha256 IS NOT NULL AND signer IS NOT NULL)),
  -- Changing a package means uploading a new version.
  UNIQUE (name, version)
);

-- A user who goes over their write limit is paused until an Admin resumes them.
ALTER TABLE users ADD COLUMN writes_paused boolean NOT NULL DEFAULT false, ADD COLUMN writes_paused_reason text;
ALTER TABLE clients ADD COLUMN write_pause_reason text;

-- Every firewall change on a cabinet: through the platform (with its command) or from outside.
CREATE TABLE firewall_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id   uuid NOT NULL REFERENCES cabinets(id),
  command_id   uuid REFERENCES commands(id),
  event_id     uuid,
  explained    boolean NOT NULL,
  operation    text,
  before       jsonb,
  after        jsonb,
  detail       jsonb,
  occurred_at  timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX firewall_changes_cabinet ON firewall_changes (cabinet_id, occurred_at DESC);

CREATE INDEX commands_writes_by_user ON commands (issued_by, issued_at DESC);

GRANT SELECT, INSERT, UPDATE ON packages TO cabinet_app;
GRANT SELECT, INSERT, UPDATE ON firewall_changes TO cabinet_app;

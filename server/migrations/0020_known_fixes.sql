-- What fixed a problem, saved with the environment it was seen in, so the same problem shows its fix next time.
-- A symptom is matched exactly: a diagnosis finding's key, or an issue type. Never a pattern.
CREATE TABLE known_fixes (
  id            uuid PRIMARY KEY,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  solution      text NOT NULL CHECK (length(solution) BETWEEN 1 AND 2000),
  finding_key   text CHECK (finding_key IS NULL OR finding_key ~ '^[a-z][a-z0-9-]{0,47}$'),
  issue_type_id uuid REFERENCES issue_types(id),
  environment   jsonb NOT NULL,
  cabinet_id    uuid REFERENCES cabinets(id),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  seen_count    integer NOT NULL DEFAULT 0,
  last_seen_at  timestamptz,
  removed_at    timestamptz,
  CHECK ((finding_key IS NULL) <> (issue_type_id IS NULL))
);
CREATE INDEX known_fixes_finding ON known_fixes (finding_key) WHERE removed_at IS NULL AND finding_key IS NOT NULL;
CREATE INDEX known_fixes_issue ON known_fixes (issue_type_id) WHERE removed_at IS NULL AND issue_type_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON known_fixes TO cabinet_app;

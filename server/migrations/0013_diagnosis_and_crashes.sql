-- One-click diagnoses (docs/spec/12-milestones-8-to-12.md "Automatic network diagnosis") and crash investigation
-- (docs/spec/13-roadmap.md phase 2).

-- A diagnosis run: the commands it issued (as the person who asked), and the findings read from their results.
-- Kept 30 days (maintenance), so the next person can see what was found.
CREATE TABLE diagnoses (
  id           uuid PRIMARY KEY,
  cabinet_id   uuid NOT NULL REFERENCES cabinets(id),
  kind         text NOT NULL CHECK (kind IN ('network')),
  run_by       uuid NOT NULL REFERENCES users(id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  state        text NOT NULL CHECK (state IN ('running', 'done', 'failed')),
  commands     jsonb NOT NULL DEFAULT '[]',
  findings     jsonb,
  failure      text
);
CREATE INDEX diagnoses_cabinet ON diagnoses (cabinet_id, started_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON diagnoses TO cabinet_app;

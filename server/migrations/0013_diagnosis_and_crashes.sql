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

-- Boots, from the heartbeat (its uptime went back) and from the agent's change events (Windows started). Reboot loops are
-- found from these, and the crash timeline shows them. Times within 3 minutes are the same boot.
CREATE TABLE cabinet_boots (
  cabinet_id  uuid NOT NULL REFERENCES cabinets(id),
  booted_at   timestamptz NOT NULL,
  source      text NOT NULL CHECK (source IN ('heartbeat', 'event')),
  PRIMARY KEY (cabinet_id, booted_at)
);
GRANT SELECT, INSERT, DELETE ON cabinet_boots TO cabinet_app;

INSERT INTO issue_types (id, key, name, severity, description, built_in) VALUES
  ('00000000-0000-4000-8000-000000000117', 'reboot_loop', 'Restarting repeatedly (possible reboot loop)', 'major',
   'The cabinet started 3 or more times within an hour, or restarted and then went quiet. A cabinet stuck in a crash loop cannot run the agent for long, so its evidence is what was collected before.', true);

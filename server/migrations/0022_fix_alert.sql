-- A fix saved from an alert is tied to it, so resolving that alert can carry the same note into its resolution.
ALTER TABLE known_fixes ADD COLUMN alert_id uuid REFERENCES alerts(id) ON DELETE SET NULL;

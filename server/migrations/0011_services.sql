-- Milestone 10 (docs/spec/12-milestones-8-to-12.md): watched services. Each level (fleet in settings 'services.watched',
-- client, site, cabinet) may name the services its cabinets keep running; the most specific level that has a list wins.
-- null means "use the level above"; an empty list means "watch nothing here".
ALTER TABLE clients  ADD COLUMN watched_services text[] CHECK (watched_services IS NULL OR cardinality(watched_services) <= 16);
ALTER TABLE sites    ADD COLUMN watched_services text[] CHECK (watched_services IS NULL OR cardinality(watched_services) <= 16);
ALTER TABLE cabinets ADD COLUMN watched_services text[] CHECK (watched_services IS NULL OR cardinality(watched_services) <= 16);

INSERT INTO issue_types (id, key, name, severity, description, built_in) VALUES
  ('00000000-0000-4000-8000-000000000114', 'service_restarted', 'Service restarted automatically', 'minor',
   'A watched service stopped and the agent started it again. Repeated restarts point at the software behind the service.', true),
  ('00000000-0000-4000-8000-000000000115', 'service_failing', 'Service will not stay running', 'major',
   'A watched service failed 3 restarts in a row. The agent keeps trying every 15 minutes; the alert closes once it runs again.', true),
  ('00000000-0000-4000-8000-000000000116', 'service_watch', 'Watched service missing or disabled', 'minor',
   'A service on the watch list does not exist on the cabinet, or is disabled, so it is not started. The watch list may name the wrong service.', true);

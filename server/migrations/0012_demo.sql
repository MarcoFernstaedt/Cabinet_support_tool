-- Demo mode (docs/platform/demo.md): an Admin can add simulated clients, sites and cabinets to show what the platform
-- does at fleet scale, next to the real cabinets. Simulated cabinets are marked by demo_scenario (non-null only for them);
-- their client is marked demo. Turning demo mode off deletes all of it. Real cabinets are never demo.
ALTER TABLE clients  ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE cabinets ADD COLUMN demo_scenario text CHECK (demo_scenario IS NULL OR demo_scenario ~ '^[a-z_]{1,32}$');
CREATE INDEX cabinets_demo ON cabinets (id) WHERE demo_scenario IS NOT NULL;

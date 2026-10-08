-- Device settings that follow the client (requested after milestone 7): the fingerprint scanner's hardware IDs can be
-- set for a whole client or one site, not only the fleet and one cabinet; and the sync cabinet's TCP ports can be set
-- for a whole client or the fleet, with a site's own ports winning. The most specific setting applies, so changing a
-- client's scanner or ports is one change, picked up by every cabinet at its next heartbeat or test.
ALTER TABLE clients ADD COLUMN scanner_hardware_ids jsonb;
ALTER TABLE sites ADD COLUMN scanner_hardware_ids jsonb;
ALTER TABLE clients ADD COLUMN sync_ports integer[] CHECK (sync_ports IS NULL OR cardinality(sync_ports) <= 4);

-- A site's ports are now its own override; none means "use the client's, else the fleet's".
ALTER TABLE sites ALTER COLUMN sync_ports DROP NOT NULL, ALTER COLUMN sync_ports DROP DEFAULT;
UPDATE sites SET sync_ports = NULL WHERE cardinality(sync_ports) = 0;

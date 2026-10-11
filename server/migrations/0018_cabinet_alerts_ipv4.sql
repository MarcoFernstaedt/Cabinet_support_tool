-- Cabinet alerts, IPv4 addresses, and the lease renewal job.
-- A cabinet alert belongs to one cabinet: it shows on that cabinet's page and in its logs, but not in the fleet-wide alert list,
-- the badge or the client and site counts (a USB device that is not plugged in is for whoever is at that cabinet).
ALTER TABLE issue_types ADD COLUMN scope text NOT NULL DEFAULT 'fleet' CHECK (scope IN ('fleet', 'cabinet'));
ALTER TABLE alerts ADD COLUMN scope text NOT NULL DEFAULT 'fleet' CHECK (scope IN ('fleet', 'cabinet'));
CREATE INDEX alerts_fleet_scope ON alerts (state, severity, last_seen DESC) WHERE scope = 'fleet';

-- The address each cabinet last reported (from its network settings), so a list of cabinets can show it.
ALTER TABLE cabinets ADD COLUMN ipv4 text CHECK (ipv4 IS NULL OR length(ipv4) <= 15), ADD COLUMN ipv4_at timestamptz;

ALTER TABLE fleet_jobs DROP CONSTRAINT fleet_jobs_operation_check;
ALTER TABLE fleet_jobs ADD CONSTRAINT fleet_jobs_operation_check
  CHECK (operation IN ('time.setZone', 'time.sync', 'firewall.applyPolicy', 'network.setDns', 'network.setIp', 'network.renewLease'));

INSERT INTO issue_types (id, key, name, severity, description, built_in, scope) VALUES
  ('00000000-0000-4000-8000-000000000122', 'usb_missing', 'Expected USB device not detected', 'minor',
   'The cabinet should have a USB device plugged in (the fingerprint scanner), but Windows sees nothing on any USB port. Check the cable and the port at the cabinet. This alert stays on the cabinet.', true, 'cabinet'),
  ('00000000-0000-4000-8000-000000000123', 'disk_space', 'Low disk space', 'minor',
   'Windows reports a drive is nearly full. Updates, logs and the cabinet application can start failing when it fills.', true, 'fleet');
INSERT INTO symptom_rules (id, issue_type_id, kind, state, match, severity, built_in) VALUES
  ('00000000-0000-4000-8000-000000000370', '00000000-0000-4000-8000-000000000122', 'map', 'live', '{"kind":"scanner","phrase":"No USB device"}', 'minor', true),
  ('00000000-0000-4000-8000-000000000371', '00000000-0000-4000-8000-000000000123', 'map', 'live', '{"kind":"error","log":"System","source":"srv","eventId":2013}', 'minor', true);
INSERT INTO symptom_rule_history (rule_id, version, change, state, issue_type_id, match, severity)
  SELECT id, 1, 'created', state, issue_type_id, match, severity FROM symptom_rules
   WHERE id IN ('00000000-0000-4000-8000-000000000370', '00000000-0000-4000-8000-000000000371');

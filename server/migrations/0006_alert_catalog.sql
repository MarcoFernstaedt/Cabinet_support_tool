-- Alerts that say what is wrong before it breaks (requested after milestone 6):
-- * every symptom rule can set its own severity, overriding its issue type's, so one issue (Drive failing)
--   can be minor for an early sign (a retried read) and major for a real failure (a bad block);
-- * major alerts show on the home page and in the Alerts tab, minor ones only on their cabinet;
-- * a starting catalog of Windows events known to come before drive failures, crashes and hardware faults.

ALTER TABLE symptom_rules ADD COLUMN severity text CHECK (severity IS NULL OR severity IN ('major', 'minor'));
ALTER TABLE symptom_rule_history ADD COLUMN severity text;

-- An alert that becomes major (a more serious symptom of the same issue arrived) is announced like a new major alert.
CREATE OR REPLACE FUNCTION alert_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('alerts', NEW.id::text || ' created');
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM pg_notify('alerts', NEW.id::text || ' ' || NEW.state);
  ELSIF NEW.severity = 'major' AND OLD.severity = 'minor' THEN
    PERFORM pg_notify('alerts', NEW.id::text || ' created');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER alert_notify ON alerts;
CREATE TRIGGER alert_notify AFTER INSERT OR UPDATE OF state, severity ON alerts FOR EACH ROW EXECUTE FUNCTION alert_notify();

INSERT INTO issue_types (id, key, name, severity, description, built_in) VALUES
  ('00000000-0000-4000-8000-000000000109', 'crash',    'System crash (blue screen)',        'major', 'Windows stopped with a bug check and restarted.', true),
  ('00000000-0000-4000-8000-000000000110', 'shutdown', 'Unexpected shutdown or power loss', 'minor', 'The cabinet turned off without shutting down: power was cut, the power button held, or it froze.', true),
  ('00000000-0000-4000-8000-000000000111', 'hardware', 'Hardware error',                    'major', 'The processor, memory or a PCIe device reported an error to Windows (WHEA).', true),
  ('00000000-0000-4000-8000-000000000112', 'service',  'Windows service failure',           'minor', 'A Windows service failed to start, hung or stopped unexpectedly.', true);

-- The starting catalog. Each rule names the log, the event source and the event ID (no level, so a warning and an
-- error of the same event both match). Admins can disable any of them, and Map to issue adds more.
INSERT INTO symptom_rules (id, issue_type_id, kind, state, match, severity, built_in) VALUES
  -- Drive failing: the disk driver's and file system's own early signs.
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"disk","eventId":7}',   'major', true),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"disk","eventId":11}',  'major', true),
  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"disk","eventId":52}',  'major', true),
  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"disk","eventId":154}', 'major', true),
  ('00000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"disk","eventId":15}',  'minor', true),
  ('00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"disk","eventId":51}',  'minor', true),
  ('00000000-0000-4000-8000-000000000307', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"disk","eventId":153}', 'minor', true),
  ('00000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"Ntfs","eventId":55}',  'major', true),
  ('00000000-0000-4000-8000-000000000309', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-Ntfs","eventId":55}', 'major', true),
  ('00000000-0000-4000-8000-000000000310', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-Ntfs","eventId":98}', 'major', true),
  ('00000000-0000-4000-8000-000000000311', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-Ntfs","eventId":140}', 'minor', true),
  ('00000000-0000-4000-8000-000000000312', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"storahci","eventId":129}', 'minor', true),
  ('00000000-0000-4000-8000-000000000313', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"stornvme","eventId":129}', 'minor', true),
  ('00000000-0000-4000-8000-000000000314', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"iaStorA","eventId":129}',  'minor', true),
  ('00000000-0000-4000-8000-000000000315', '00000000-0000-4000-8000-000000000102', 'map', 'live', '{"kind":"error","log":"System","source":"iaStorAVC","eventId":129}', 'minor', true),
  -- Hardware error (WHEA): fatal is major, corrected errors are an early sign.
  ('00000000-0000-4000-8000-000000000320', '00000000-0000-4000-8000-000000000111', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-WHEA-Logger","eventId":18}', 'major', true),
  ('00000000-0000-4000-8000-000000000321', '00000000-0000-4000-8000-000000000111', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-WHEA-Logger","eventId":17}', 'minor', true),
  ('00000000-0000-4000-8000-000000000322', '00000000-0000-4000-8000-000000000111', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-WHEA-Logger","eventId":19}', 'minor', true),
  ('00000000-0000-4000-8000-000000000323', '00000000-0000-4000-8000-000000000111', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-WHEA-Logger","eventId":47}', 'minor', true),
  -- Crashes and unexpected shutdowns.
  ('00000000-0000-4000-8000-000000000330', '00000000-0000-4000-8000-000000000109', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-WER-SystemErrorReporting","eventId":1001}', 'major', true),
  ('00000000-0000-4000-8000-000000000331', '00000000-0000-4000-8000-000000000109', 'map', 'live', '{"kind":"error","log":"System","source":"BugCheck","eventId":1001}', 'major', true),
  ('00000000-0000-4000-8000-000000000332', '00000000-0000-4000-8000-000000000110', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-Kernel-Power","eventId":41}', 'minor', true),
  ('00000000-0000-4000-8000-000000000333', '00000000-0000-4000-8000-000000000110', 'map', 'live', '{"kind":"error","log":"System","source":"EventLog","eventId":6008}', 'minor', true),
  -- Driver and service failures, network faults, update failures.
  ('00000000-0000-4000-8000-000000000340', '00000000-0000-4000-8000-000000000103', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-Kernel-PnP","eventId":219}', 'minor', true),
  ('00000000-0000-4000-8000-000000000341', '00000000-0000-4000-8000-000000000112', 'map', 'live', '{"kind":"error","log":"System","source":"Service Control Manager","eventId":7000}', 'minor', true),
  ('00000000-0000-4000-8000-000000000342', '00000000-0000-4000-8000-000000000112', 'map', 'live', '{"kind":"error","log":"System","source":"Service Control Manager","eventId":7009}', 'minor', true),
  ('00000000-0000-4000-8000-000000000343', '00000000-0000-4000-8000-000000000112', 'map', 'live', '{"kind":"error","log":"System","source":"Service Control Manager","eventId":7011}', 'minor', true),
  ('00000000-0000-4000-8000-000000000344', '00000000-0000-4000-8000-000000000112', 'map', 'live', '{"kind":"error","log":"System","source":"Service Control Manager","eventId":7023}', 'minor', true),
  ('00000000-0000-4000-8000-000000000345', '00000000-0000-4000-8000-000000000112', 'map', 'live', '{"kind":"error","log":"System","source":"Service Control Manager","eventId":7031}', 'minor', true),
  ('00000000-0000-4000-8000-000000000346', '00000000-0000-4000-8000-000000000112', 'map', 'live', '{"kind":"error","log":"System","source":"Service Control Manager","eventId":7034}', 'minor', true),
  ('00000000-0000-4000-8000-000000000350', '00000000-0000-4000-8000-000000000104', 'map', 'live', '{"kind":"error","log":"System","source":"Tcpip","eventId":4199}', 'major', true),
  ('00000000-0000-4000-8000-000000000351', '00000000-0000-4000-8000-000000000104', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-DNS-Client","eventId":1014}', 'minor', true),
  ('00000000-0000-4000-8000-000000000360', '00000000-0000-4000-8000-000000000106', 'map', 'live', '{"kind":"error","log":"System","source":"Microsoft-Windows-WindowsUpdateClient","eventId":20}', 'minor', true);

INSERT INTO symptom_rule_history (rule_id, version, change, state, issue_type_id, match, severity)
  SELECT id, 1, 'created', state, issue_type_id, match, severity FROM symptom_rules WHERE id::text LIKE '00000000-0000-4000-8000-0000000003%';

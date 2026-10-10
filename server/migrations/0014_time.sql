-- Time zone and clock (docs/spec/13-roadmap.md module 21). Each site may say which time zone its cabinets should use; each
-- cabinet reports its zone in its heartbeat (its clock offset was already kept). A cabinet in the wrong zone, or whose
-- clock is more than two minutes off the server's, gets a minor alert that closes on its own once it is right again.
ALTER TABLE sites ADD COLUMN time_zone text CHECK (time_zone IN ('Eastern Standard Time', 'Central Standard Time', 'Mountain Standard Time',
  'US Mountain Standard Time', 'Pacific Standard Time', 'Alaskan Standard Time', 'Hawaiian Standard Time'));
ALTER TABLE cabinets ADD COLUMN time_zone_id text CHECK (length(time_zone_id) BETWEEN 1 AND 64);

INSERT INTO issue_types (id, key, name, severity, description, built_in) VALUES
  ('00000000-0000-4000-8000-000000000118', 'time_zone_wrong', 'Wrong time zone', 'minor',
   'The cabinet''s Windows time zone is not its site''s. Schedules, logs and dispensing times show the wrong local time. Correct it from the cabinet''s Time section, or for many cabinets from Fleet operations.', true),
  ('00000000-0000-4000-8000-000000000119', 'clock_off', 'Clock is off', 'minor',
   'The cabinet''s clock is more than two minutes away from the server''s. Sync the clock; if it drifts again, check Windows Time and its source.', true);

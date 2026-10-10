-- Scenario B, a site network outage (docs/spec/13-roadmap.md module 40): every cabinet at a site went quiet within the
-- same few minutes. One cabinet offline is "Offline"; all of a site's cabinets offline together points at the site's
-- network or power, not at any one cabinet, so each gets this major alert, which closes when any of them is heard again.
INSERT INTO issue_types (id, key, name, severity, description, built_in) VALUES
  ('00000000-0000-4000-8000-000000000120', 'site_outage', 'Whole site offline (network or power)', 'major',
   'Every cabinet at the site stopped reporting within the same 10 minutes. That points at the site: its internet connection, firewall, switch or power, not the cabinets. Check with the site before working on any one cabinet.', true);

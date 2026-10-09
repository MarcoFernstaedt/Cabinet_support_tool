-- Milestone 9 (docs/spec/12-milestones-8-to-12.md): confirmation levels and the client firewall policy.

-- A step-up or password confirmation can be bound to the exact parameters the person confirmed.
ALTER TABLE step_up_tokens ADD COLUMN params_hash text CHECK (params_hash IS NULL OR params_hash ~ '^[0-9a-f]{64}$');

-- Every account now needs an authenticator at sign-in; the setting that made it optional is gone. Anyone signed in
-- without one is signed out, and sets one up at their next sign-in.
DELETE FROM settings WHERE key = 'accounts.requireTotp';
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE NOT totp_enabled);

-- Each client's firewall policy ({"domain":"on"|"off","private":…,"public":…}); null uses the fleet default
-- (the settings key 'firewall.policy', all off unless an Admin changes it).
ALTER TABLE clients ADD COLUMN firewall_policy jsonb;

-- Each profile's on/off state from the cabinet's latest heartbeat ({"domain":true,…}), compared with the policy.
ALTER TABLE cabinets ADD COLUMN firewall_profiles jsonb;

INSERT INTO issue_types (id, key, name, severity, description, built_in) VALUES
  ('00000000-0000-4000-8000-000000000113', 'firewall_policy', 'Firewall differs from client policy', 'minor',
   'One or more firewall profiles are on or off unlike the client''s firewall policy. Apply the policy from the cabinet page, or to every cabinet of a site or client at once.', true);

-- A bulk change's commands share one bulk_id, so the bulk counts as one write toward the person's hourly limit.
ALTER TABLE commands ADD COLUMN bulk_id uuid;

-- Fleet alarm level (decision-log D25): a fleet pattern rings the alarm (banner, sound, desktop notification) when it is major, or when a
-- minor one has spread to the Admin's "minor rings at" number of sites. alarmed_at is when it first rang; NULL means it is listed quietly.
-- Every pattern opened before this rang (D23), so they keep their alarm.
ALTER TABLE fleet_patterns ADD [alarmed_at] datetime2(3) NULL;
GO
UPDATE fleet_patterns SET alarmed_at = opened_at;
GO

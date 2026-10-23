-- The applications and services a cabinet may be asked to control (docs/spec/13-roadmap.md: process.end and app.restart with a
-- per-client allowlist). One JSON column per scope, with the fleet default as one settings row, exactly as the watched services and
-- the file-facts paths are kept, so the list travels with the scope it belongs to and a removed scope takes its list with it.
--
-- The column's own check is the second one (the contract caps the request too, and the service refuses before it writes): the value
-- must be a JSON object holding at most 32 entries. CASE, not OR: it is what makes the order of evaluation certain, so
-- JSON_QUERY is never handed a scalar, which it answers with an error rather than NULL.

ALTER TABLE clients ADD [approved_apps] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL;
GO
ALTER TABLE clients ADD CONSTRAINT [clients_approved_apps_check] CHECK ([approved_apps] IS NULL OR (CASE WHEN ISJSON([approved_apps], OBJECT) = 1 THEN CASE WHEN JSON_QUERY([approved_apps], '$.entries[32]') IS NULL THEN 1 ELSE 0 END ELSE 0 END) = 1);
GO

ALTER TABLE sites ADD [approved_apps] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL;
GO
ALTER TABLE sites ADD CONSTRAINT [sites_approved_apps_check] CHECK ([approved_apps] IS NULL OR (CASE WHEN ISJSON([approved_apps], OBJECT) = 1 THEN CASE WHEN JSON_QUERY([approved_apps], '$.entries[32]') IS NULL THEN 1 ELSE 0 END ELSE 0 END) = 1);
GO

ALTER TABLE cabinets ADD [approved_apps] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL;
GO
ALTER TABLE cabinets ADD CONSTRAINT [cabinets_approved_apps_check] CHECK ([approved_apps] IS NULL OR (CASE WHEN ISJSON([approved_apps], OBJECT) = 1 THEN CASE WHEN JSON_QUERY([approved_apps], '$.entries[32]') IS NULL THEN 1 ELSE 0 END ELSE 0 END) = 1);
GO

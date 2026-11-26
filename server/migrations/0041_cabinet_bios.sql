-- The BIOS version a cabinet reports, kept on the cabinet beside its make and model (decision-log D157), so the fleet's incident and
-- pattern views can compare it across thousands of cabinets in one read. A configuration version is stored packed and cannot be read
-- in SQL. Set from the same reports as the model: the system category's hardware item and a system.hardware answer. Empty until a
-- cabinet next reports.
ALTER TABLE cabinets ADD [bios_version] nvarchar(200) NULL;
GO
ALTER TABLE cabinets ADD CONSTRAINT [cabinets_bios_version_check] CHECK ([bios_version] IS NULL OR LEN([bios_version]) BETWEEN 1 AND 200);
GO

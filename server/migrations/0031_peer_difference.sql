-- A difference nobody declared, as it appears (finding F17, decision-log D54): a cabinet whose configuration just changed so that it no
-- longer matches what every other cabinet of its role at its site reports, where no baseline says what it should be. A named, minor alert.
INSERT INTO issue_types ([id], [key], [name], [severity], [description], [built_in], [scope]) VALUES
  (N'00000000-0000-4000-8000-000000000129', N'peer_difference', N'Differs from the other cabinets of its role at its site', N'minor', N'A setting on this cabinet changed in the last 30 days and is now unlike the same setting on every other cabinet of its role at its site, and no baseline declares what it should be. It may be deliberate. Compare it with a cabinet that works; if this is how the site should be, capture a baseline so it is declared.', 1, N'fleet');
GO

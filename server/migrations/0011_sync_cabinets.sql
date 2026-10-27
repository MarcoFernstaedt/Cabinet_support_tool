-- Sync cabinets and satellites (docs/spec/05-server-spec.md "Sync cabinets and satellites").
--
-- A site may have several sync cabinets. The address satellites reach moves from the site to each sync cabinet, and each satellite
-- names the sync cabinet it uses. The ports stay where they were: the site's own, else the client's, else the fleet's.
--
--   sync_cabinet_id      on a satellite: the sync cabinet it reaches. It counts only while that cabinet is an active sync cabinet at
--                        the same site (services/sync-cabinets.ts); otherwise the satellite's enrollment is incomplete.
--   sync_address         on a sync cabinet: the private IPv4 address its satellites reach.
--   sync_address_source  'reported': taken from the cabinet's own network settings, and followed when they change;
--                        'admin':    set by an Admin, never replaced by a report.
ALTER TABLE cabinets ADD
  [sync_cabinet_id] uniqueidentifier NULL,
  [sync_address] varchar(15) NULL,
  [sync_address_source] varchar(8) NULL;
GO
ALTER TABLE cabinets ADD
  CONSTRAINT [cabinets_sync_cabinet_fkey] FOREIGN KEY ([sync_cabinet_id]) REFERENCES cabinets ([id]),
  CONSTRAINT [cabinets_sync_cabinet_not_self] CHECK ([sync_cabinet_id] IS NULL OR [sync_cabinet_id] <> [id]),
  CONSTRAINT [cabinets_sync_address_source_check] CHECK ([sync_address_source] IS NULL OR [sync_address_source] IN ('reported', 'admin')),
  -- An address always says where it came from, and a source never stands without an address.
  CONSTRAINT [cabinets_sync_address_pair] CHECK (([sync_address] IS NULL AND [sync_address_source] IS NULL) OR ([sync_address] IS NOT NULL AND [sync_address_source] IS NOT NULL)),
  -- The dotted-quad shape, as the site column had it; the server accepts only RFC 1918 addresses (settings.ts isPrivateIpv4).
  CONSTRAINT [cabinets_sync_address_check] CHECK ([sync_address] IS NULL OR (LEN([sync_address]) BETWEEN 7 AND 15 AND [sync_address] NOT LIKE '%[^0-9.]%'
    AND [sync_address] LIKE '%.%.%.%' AND [sync_address] NOT LIKE '%.%.%.%.%' AND [sync_address] NOT LIKE '%..%' AND [sync_address] NOT LIKE '.%' AND [sync_address] NOT LIKE '%.'));
GO
CREATE INDEX [cabinets_sync_cabinet_idx] ON cabinets ([sync_cabinet_id]) WHERE [sync_cabinet_id] IS NOT NULL;
GO

-- Existing sites had one typed address and no link. Where a site has exactly one sync cabinet, that address becomes the sync cabinet's
-- (as set by an Admin, so a report never replaces it) and every satellite there is linked to it: nothing changes on the wire. Satellites
-- at a site with no sync cabinet, or more than one, are left unlinked and show as incomplete until someone assigns them.
WITH single AS (
  SELECT k.site_id, MIN(CAST(k.id AS char(36))) AS sync_id
    FROM cabinets k WHERE k.role = 'sync' AND k.status = 'active'
   GROUP BY k.site_id HAVING COUNT(*) = 1
)
UPDATE k SET k.sync_address = s.sync_address, k.sync_address_source = 'admin'
  FROM cabinets k JOIN single x ON CAST(x.sync_id AS uniqueidentifier) = k.id JOIN sites s ON s.id = k.site_id
 WHERE s.sync_address IS NOT NULL AND LEN(s.sync_address) BETWEEN 7 AND 15;
GO
WITH single AS (
  SELECT k.site_id, MIN(CAST(k.id AS char(36))) AS sync_id
    FROM cabinets k WHERE k.role = 'sync' AND k.status = 'active'
   GROUP BY k.site_id HAVING COUNT(*) = 1
)
UPDATE k SET k.sync_cabinet_id = CAST(x.sync_id AS uniqueidentifier)
  FROM cabinets k JOIN single x ON x.site_id = k.site_id
 WHERE k.role = 'satellite' AND k.status <> 'removed';
GO

-- The site's address is gone; its ports stay.
ALTER TABLE sites DROP CONSTRAINT [sites_sync_address_check];
GO
ALTER TABLE sites DROP COLUMN [sync_address];
GO

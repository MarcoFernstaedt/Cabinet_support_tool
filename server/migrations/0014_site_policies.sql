-- Site policies with fleet → client → site inheritance (docs/spec/05-server-spec.md "Site policies"). The owner's decision: the
-- firewall policy gains a site level, and the time zone gains client and fleet defaults; the network standard stays per site.
--
--   sites.firewall_policy   The site's own firewall policy (JSON {domain, private, public}, each "on" or "off"). NULL: the client's,
--                           else the fleet's, applies.
--   clients.time_zone       The zone the client's sites use unless a site sets its own. NULL: the fleet default (the settings row
--                           time.zone, {"timeZone": ...}) applies, and with none of the three no zone is checked.
-- Nothing existing changes: every new column starts NULL, so every cabinet keeps the policy and zone it had.
ALTER TABLE sites ADD [firewall_policy] varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL
  CONSTRAINT [sites_firewall_policy_json] CHECK ([firewall_policy] IS NULL OR ISJSON([firewall_policy], VALUE) = 1);
GO
ALTER TABLE clients ADD [time_zone] nvarchar(64) NULL
  CONSTRAINT [clients_time_zone_check] CHECK ([time_zone] IN ('Eastern Standard Time', 'Central Standard Time', 'Mountain Standard Time', 'US Mountain Standard Time', 'Pacific Standard Time', 'Alaskan Standard Time', 'Hawaiian Standard Time'));
GO

-- The clock tolerance, adjustable site by site (docs/spec/05-server-spec.md "Site policies", decision-log D109). The owner asked that
-- what the clock alert judges be adjustable per site, not only fleet-wide; the zone and the firewall policy already are.
--
--   sites.clock_tolerance_seconds    How far a cabinet's clock may be from the server's at this site before it counts as off. NULL:
--                                    the client's, else the fleet's (the settings row time.clockTolerance, {"seconds": n}), else 120.
--   clients.clock_tolerance_seconds  The tolerance the client's sites use unless a site sets its own.
--
-- From 10 to 120 seconds. Not above 120: the agent refuses a command issued more than two minutes ahead of its own clock
-- (03-protocol.md), so a looser tolerance would hide a clock that already breaks commands.
-- Nothing existing changes: both columns start NULL, so every cabinet keeps the 120 seconds it had.
ALTER TABLE sites ADD [clock_tolerance_seconds] int NULL
  CONSTRAINT [sites_clock_tolerance_check] CHECK ([clock_tolerance_seconds] BETWEEN 10 AND 120);
GO
ALTER TABLE clients ADD [clock_tolerance_seconds] int NULL
  CONSTRAINT [clients_clock_tolerance_check] CHECK ([clock_tolerance_seconds] BETWEEN 10 AND 120);
GO

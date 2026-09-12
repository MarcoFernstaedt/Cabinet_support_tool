# Time zones

The fleet spans thirteen countries. A maintenance window of 02:00 to 06:00
means 02:00 **at the cabinet**, and evaluating it against the server's clock
would run a reboot in the middle of a clinic's afternoon somewhere. That is a
correctness requirement, not a formatting preference.

## The rule

Everything stored and everything transmitted is UTC, as `DateTimeOffset`.
There is no `DateTime` in any contract. Local time exists at exactly two edges:

1. the maintenance-window and scheduled-install comparisons on the server,
   which are made in the **cabinet's** zone
2. the display in the console, which is made in the **reader's** zone and is
   labelled as such, with the cabinet's own local time shown beside it on the
   detail view

Nothing in between converts, and nothing in between needs to.

## Where a cabinet's zone comes from

The agent reports `SystemInfo.TimeZoneId` and the server stores it on the
cabinet. Windows agents report Windows zone ids and this server may run on
Linux, so the lookup goes through the conversion .NET 8 performs rather than
assuming either family.

A zone this host cannot resolve is reported as unknown rather than falling back
to the server's own. A window evaluated in the wrong zone is worse than one
that refuses to evaluate, because it looks like it worked. A cabinet with no
resolvable zone is therefore never inside its maintenance window, and a
disruptive action that needs one is refused.

## Windows that cross midnight

22:00 to 04:00 is an ordinary maintenance window and is two intervals, not one.
Comparing it as a single range silently matches nothing — the kind of bug that
produces a support ticket reading "the overnight reboot never happens" and no
error anywhere.

## Daylight saving

A window pinned to a UTC hour drifts an hour off the clinic's night twice a
year, in opposite directions in the northern and southern halves of the fleet.
Evaluating in the cabinet's zone means the same local hour before and after a
transition maps to different UTC instants, which is the correct behaviour and
is what the tests assert: 09:00 UTC is inside a 02:00–04:00 Chicago window on
7 March 2026 and outside it on 9 March.

### Scheduled installs are specified in cabinet-local time

This is the one place the contract carries a local time, and it is deliberate.

A rep and a clinic agree on "Tuesday at 2am". The console sends
`scheduledForLocal`; the server resolves the cabinet's zone, converts, and adds
`scheduledForUtc` — which a caller may not supply, for the same reason a caller
may not supply a resolved probe address.

Carrying the local time is what makes the daylight-saving check possible at
all. Converting an instant that arrived as UTC can never produce an invalid
local time: every UTC instant maps to exactly one valid local one. A request
phrased in UTC has already lost the evidence that the rep asked for an hour the
zone skips. Phrased in local time it is detectable, and 02:30 on the morning
Chicago springs forward is refused — with a message saying the clock skips that
hour — rather than slid an hour later without anybody being told.

An ambiguous local time, on the morning a zone falls back, happens twice. The
earlier of the two is taken, which is the one a person reading a clock means,
and both the local time and the derived instant are recorded on the request so
the choice is visible rather than deduced.

## Clock drift

Every heartbeat carries the cabinet's own clock reading, and the server records
the difference from its own. Drift breaks two things that do not announce
themselves: site synchronisation, and the ordering of this platform's audit
records against a dispensing system's own log. A cabinet whose clock differs
materially from UTC is flagged in the fleet health summary and called out on
its detail view, with its own line rather than buried in a diagnostics panel.

## Display

The console shows timestamps in the reader's local zone, labelled. The cabinet
detail additionally shows the cabinet's current local time, labelled with its
zone, because "02:00" means nothing across thirteen countries without saying
whose.

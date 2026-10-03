# Site topology and the sync cabinet

## Retired peer monitoring

Scheduled cabinet-to-cabinet ICMP sampling, target configuration writes, summary ingestion,
and the one-click sync-link test are retired. Existing interval evidence, alerts,
`CabinetLinkProbe` rows and action receipts remain historical records; none is a
current reachability measurement. The shipped Agent registers no peer probe executor.
The maintenance-test composition retains the separate `TestCabinetPort` TCP executor,
not peer ICMP. Generic host diagnostics are outside this retirement, but are not
shipped as executable actions in the monitoring-only build.

The hierarchy is client, then site, then cabinet. Both extremes are ordinary
and neither is a special case: a client with one site and one cabinet, and a
client with many sites and several cabinets per site.

## Client is a boundary, not a label

A client is a row, not a string on the cabinet. That is a security decision
rather than a normalisation one: a cabinet-to-cabinet probe may never cross a
client boundary, and enforcing that against a denormalised name would mean
comparing two strings that a rename can quietly desynchronise.

## Roles

`CabinetRole` has three values and no default that means anything:

- **Sync** — this site's data lives on this cabinet. A site has at most one.
- **Satellite** — syncs against the site's sync cabinet.
- **Standalone** — a site with no sync cabinet. Supported, and not an error.

`Site.SyncCabinetId` is a single nullable column. That makes "a site has at
most one sync cabinet" a property of the schema rather than a rule a service
has to remember, and it makes a standalone site the natural absence rather than
a flag somebody has to set.

The role is set by the approving Supervisor at the moment a machine becomes a
cabinet, and can be changed later by a Supervisor. Both are audited. An agent
never sets it: a machine cannot promote itself to the cabinet its clinic's data
lives on.

Approving a second cabinet as a site's Sync is refused rather than silently
demoting the first. Demotion is a decision somebody makes on purpose.

### One implementation note

A site points at its sync cabinet and that cabinet points back at its site. A
brand-new pair of rows written in one statement batch is therefore a circular
foreign-key dependency that no ordering of the two inserts satisfies. The
cabinet goes in first and the site's pointer follows, inside one transaction so
a site is never left pointing at nothing.

## Historical reachability and cabinet diagnostics

Server-to-cabinet health does not establish a satellite-to-sync link. Older
`CabinetLinkProbe` source-target rows and connectivity incident evidence remain
readable as historical observations; no late `PingCabinet` or
`TraceRouteToCabinet` result creates or updates a link probe. Authenticated
result receipts for previously dispatched actions still complete their action
record (including `UnknownResult`) and duplicate completed receipts remain
idempotent. Unknown request IDs and cross-cabinet reports retain their refusal
semantics.

`PingCabinet` and `TraceRouteToCabinet` are retired: authenticated direct action
requests and the former sync-link shortcut return 410, the execution-policy
catalog excludes both in every mode, and neither has a registered Agent executor
in shipping or historical maintenance-test compositions. The enum and catalog
metadata remain for old action history. `TestCabinetPort` is a separate TCP
diagnostic retained only in the compiled maintenance-test composition; it is not
an enabled shipping action. `PingHost`, `TraceRoute` and `TestPortConnectivity`
are generic host diagnostics, not retired by this peer-ICMP change; shipping
monitoring policy still prevents dispatching them.

## Fleet and site aggregates

The fleet view answers "what is wrong across all of this" for a scope the rep
chooses: everything, one client, one site, or one department. It counts
cabinets by disk health, cabinets stale beyond a configurable window, cabinets
with pending updates and with pending *security* updates separately, drives in
Watch or Failing, reboot pending, auto-start services stopped, and the spread of
agent versions.

Two properties make that affordable at 7,000 cabinets, and both are in the code
rather than in a note:

- **Aggregates project to extracted columns and never deserialize a payload.**
  `PendingSecurityUpdateCount` and `AutoStartServicesStoppedCount` are pulled out
  of a check-in at ingest and stored as columns, precisely so the fleet view can
  count them in the database. Reading them back out of stored JSON would mean
  materialising the estate to answer one question.
- **Every drill-down is paginated and every query is `AsNoTracking`.** A fleet
  aggregate that loads the change tracker with 7,000 entities is a slow page
  today and an unusable one at twice the size.

The counts that describe a *state* are distinguished from the counts that
describe a *staleness*: a cabinet that has not reported for two days is not
healthy and is not unhealthy, it is silent, and the window after which silence
counts is configuration (`AgentIngest.StaleAfterHours`, default 24) rather than
a constant.

## How the views are arranged

The fleet view groups by site, and within each site the sync cabinet is listed
first — it is the one whose failure explains the others, so a reader who scans
only the first row of each group has still read the row that matters. Sites
whose sync cabinet is itself unhealthy sort to the top, because that is the
condition that explains a whole clinic rather than one machine.

A standalone site says it is standalone. Blank fields where a sync cabinet
would be read as a fault, and a site with one cabinet is not a fault.

The site view carries each site's sync reachability as its own summary — how
many satellites are reaching it, how many are not, and how many have never
probed — rather than a single reachable/unreachable flag. "Never probed" is the
common state and is not the same fact as "not reaching"; collapsing them would
report a working site as broken every time nobody had asked.

Every cabinet named anywhere in these views carries its full `CabinetPath`;
a hostname alone is not a unique identifier across clients and sites.

# Site topology and the sync cabinet

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

## Reachability is a different fact from health

The question a support rep has when a whole clinic misbehaves is not "is the
sync cabinet up" — the fleet view answers that — but "can this satellite reach
it".

Those are different facts, and only the second explains the site. A sync
cabinet can be perfectly reachable from the server and unreachable from the
machine standing next to it: a switch, a VLAN, a firewall rule, a cable. The
server's own view says nothing about the link between two machines in a room
it is not in.

So the console never infers reachability from the sync cabinet being online.
Either a probe has been run **from the satellite**, or the cabinet detail says
that none has. `CabinetLinkProbe` holds the most recent probe per source-target
pair, so the detail view can answer without scanning an action history.

## Cabinet-to-cabinet diagnostics

Three actions take a target cabinet:

| Action | Approval | What it answers |
|---|---|---|
| `PingCabinet` | none | can this cabinet reach that one at all |
| `TestCabinetPort` | none | is the host up with the port filtered |
| `TraceRouteToCabinet` | none | where in the path it stops |

None requires approval, and every rep may run all three. A probe is an
observation; making a rep wait for a second pair of eyes to find out whether a
site can talk to itself would mean nobody ever runs it.

The three free-target probes — `PingHost`, `TraceRoute` and
`TestPortConnectivity` — sit alongside them and are the same in every respect
except that the rep supplies the host. They are still not a general network
tool: `DiagnosticHostPolicy` refuses loopback, the unspecified address,
broadcast, multicast and link-local targets on the server, and the agent
re-checks the port against the CUBEX list.

### The rules that make them safe

**The rep names a cabinet. The server resolves the address.** There is no host
or address parameter on any of these actions. The console sends a
`targetCabinetId`; the server looks up that cabinet's last reported adapter
address and adds `resolvedTargetAddress` to the dispatched request. A request
that arrives already carrying a resolved address is refused, because that
address would then be the caller's choice rather than the server's. The agent
refuses one that did not arrive that way, parses it as an `IPAddress` rather
than accepting text, and refuses loopback, multicast and unspecified addresses.

**Source and target must belong to the same client.** A cross-client target is
refused server-side and an audit row is written under
`CrossClientCabinetLinkTestRejected`. The response says "not found" rather than
"wrong client", so a rep learns nothing about a client they cannot see.

**Same-site is the default.** A cross-site target within the same client is
possible but must be asked for explicitly, and is audited under a distinct
event — `CrossSiteCabinetLinkTest` rather than `CabinetLinkTest` — so a
reviewer can tell the two apart without reading parameters.

**The port list is the server's.** `TestCabinetPort` accepts only ports the
CUBEX stack uses: 135, 443, 445, 1433, 3389, 5985, 5986. An unconstrained port
parameter would be a port scanner with extra steps. The agent holds its own
copy of the same list and re-checks against it, which is what keeps a
compromised or simply buggy server from steering an agent outside it.

**Nothing shells out.** The trace route is built from `Ping` with an
increasing TTL rather than by running `tracert`. That is not stylistic:
shelling out would give the agent a general mechanism for launching programs,
and the agent's safety rests on not having one.

Results are recorded as Observed audit events naming both cabinets, so it is
always answerable which network was reached from which cabinet, by whom.

## One click, on the cabinet detail

The common case by a wide margin is "can this satellite reach its sync
cabinet", so it is one button. `POST /api/actions/cabinets/{id}/test-sync-link`
takes no target: the server resolves the target from the cabinet's own site and
the address from that cabinet's last adapter. The rep selects nothing and types
nothing, and therefore cannot select the wrong thing.

The probe runs on the cabinet, so the answer arrives with a later check-in
rather than with the response. The console says so rather than showing a
spinner that stops with nothing visibly changed.

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

Every cabinet named anywhere in these views carries its full `CabinetPath`, for
the reason set out in [console.md](console.md): a hostname alone is not an
identifier in an estate this size.

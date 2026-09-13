# Product requirements

## Deployment

Mashura hosts the support server on its own infrastructure. The support console connects to that server. Each cabinet runs a Windows agent that initiates outbound connections to the same service. The product does not require an inbound listener or a desktop session on a customer cabinet.

A client can have several locations. A location can have several cabinets. Typically one cabinet at the location holds the local dispensing application database and acts as the sync cabinet. Other cabinets communicate with it through the customer network. The support server is separate from that local database and must not collect its contents.

The hierarchy is client, location, cabinet. Code calls a location a Site. Existing Sync, Satellite and Standalone roles remain useful. A site may have no sync cabinet, but may not have two active sync assignments.

## Operator work

1. Find a cabinet using its client, site, department, hostname, serial number or identifier. Keep its complete identity visible while viewing data and confirming an action.
2. Read Windows health, performance, storage, process and service information. Show when each observation was collected. Missing information must remain unknown.
3. Retrieve and display Windows event records through approved views with explicit collection limits and access records.
4. Inspect IP addresses, DNS, gateways, DHCP and adapter state. Run bounded ping, route and port checks from a cabinet, including checks to another cabinet at the same location.
5. Change approved network settings with an exact prior snapshot, confirmation and automatic recovery. Losing the support connection must not remove the recovery path.
6. Manage approved Windows services and applications. Confirm the exact process instance before termination and preserve the intended user session when launching an interactive application.
7. Inspect, select, schedule and install Windows updates. Check current occupancy and the approved maintenance window immediately before any disruptive step. Do not run an overdue schedule simply because the machine has come online.
8. Change display orientation when support needs to move controls onto a usable portion of a damaged display. Enumerate the actual display, validate a supported orientation, preserve the prior mode, and restore it if confirmation fails. Rotation is a required feature, not yet a verified implementation.
9. Follow each action through submission, approval if required, delivery, execution and a displayed result. Request acceptance alone must never appear as successful execution.

## Safety boundaries

Cabinet sensors and physical actuation are out of scope until the hardware interface and operational requirements are available. Drawer opening, lock release and cubie opening must remain unavailable. The Windows support scope is not permission to add an arbitrary shell, script execution, database query console or unrestricted file access.

A disruptive action requires the configured authorization, a reason, a ticket reference and explicit target confirmation. Existing second person approval remains in place. Unknown local safety state refuses execution. Retries must not cause a second effect when the first outcome is uncertain.

All network diagnostics need explicit destinations and bounded resource use. Customer identity and site checks must use trusted records rather than hostname spelling. A shared secret that can impersonate any cabinet is not an acceptable device identity for production.

## Acceptance evidence

Each supported operation needs a successful lab case, a denied case and relevant failure cases. Native Windows operations require an authorized disposable machine with a recovery console. Tests that replace Windows APIs with fakes are useful but do not replace this evidence.

Production acceptance also needs device credential rotation and revocation, support session containment, populated database upgrades, backup recovery, diagnostics retention, dependency review, resource measurements and an approved deployment configuration. No document or passing unit test is a security certification.

## Decisions still needed

Mashura must confirm supported Windows versions, identity provider and MFA requirements, permitted role differences, approved application paths and service names, maintenance policy, data retention and hosting jurisdiction. Lightweight resource budgets and the required monitoring refresh interval also need an agreed target and measurements.

The display example does not authorize touch input remapping or changing an unknown device driver. Those need their own requirements if Windows display rotation is insufficient.

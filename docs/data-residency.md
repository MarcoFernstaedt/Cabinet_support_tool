# Data handling and residency

The support server runs on Mashura infrastructure, not at a customer site. That placement does not by itself approve data transfers or make the service safe for a particular jurisdiction. Production deployment remains blocked until Mashura approves the hosting location, access policy, retention and applicable transfer arrangements.

## What crosses the network

The agent collects Windows machine information. Routine telemetry includes system identity and health, performance, storage and update summaries. Inventory includes installed software, service configuration, network settings, storage details and startup entries. Process lists and Windows event records can be requested separately.

These records are not automatically anonymous. Hostnames, serial numbers, IP and MAC addresses identify equipment. Service account names can identify people or organizations. Windows event messages and startup command strings can contain personal information, application data or secrets even when the contract has no field named password or patient.

The intended product scope excludes dispensing database contents, patient records and biometric templates. That is a restriction on collection, not proof that arbitrary Windows event text contains none of those values. Field name checks are not sufficient evidence of redaction.

Diagnostic bundles may include agent log files and a telemetry snapshot. They must be reviewed for sensitive content before sharing. The collector's own logs are file contents even though the agent does not offer unrestricted file retrieval.

## Current storage behavior

The server persists diagnostic result payloads against action requests. Event records are not guaranteed to disappear when the operator closes the view. The initial audit found no implemented result expiry policy covering all stored action payloads. Do not promise temporary display without retention until that behavior is implemented and tested.

Telemetry retention uses separate heartbeat, inventory and SMART policies. Configuration describes intended retention; throughput and failure recovery must be measured before assuming every record meets those ages.

Audit entries are protected against ordinary application edits, but application rules do not prove resistance to a compromised database administrator or server. Backup copies also retain data. Any retention or deletion policy must cover primary storage, logs, exported results and backups.

## Required decisions

- Approve the actual server and backup jurisdictions and the transfer basis for each customer location.
- Define who can read diagnostic payloads, including event messages and service account details.
- Specify what the agent must exclude or redact before transmission, with representative synthetic tests.
- Set separate retention policies for diagnostic content and minimal audit evidence.
- Decide how deletion obligations, incident investigation and audit preservation interact.
- Verify encryption, certificate handling, credential storage and database access privileges in the deployment.

Use synthetic data for development and demonstrations. Do not copy customer logs into this repository, public issues, screenshots or test fixtures. A local lab demonstration is not compliance approval.

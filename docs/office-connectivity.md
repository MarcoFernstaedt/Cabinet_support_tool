# Office connectivity monitoring slice

This is an opt-in, observational office lab feature. It is not fleet certification and does not authorize changes to cabinet networking, firewall rules, applications or databases. Native Windows 10/11 installation, ICMP behavior, WPF rendering, keyboard and screen-reader acceptance are **BLOCKED until independently exercised on lab machines**. Linux integration tests inject probe observations; they do not prove native Windows behavior.

## What is implemented

A Supervisor pins a bounded set of registered, active cabinets at the source cabinet's own site. Each address is explicitly approved, not taken from agent-reported adapter inventory and not resolved through DNS. The server derives the sync role from site topology. Ordinary support users can read observations but cannot change these targets.

The shipped Agent composition includes a separate `ConnectivityWorker`. Nothing is probed before local enrollment approval and a valid server plan. Each configured target receives one managed ICMP echo on a nominal 60 second timer, with a two second timeout and no retry burst. The fixed maximum is the designated sync cabinet plus three peers. A site with no sync cabinet can have up to three peers. This slice uses a fixed approved subset, not rotating discovery or a full mesh.

The agent maintains only three-sample interval counters: replies, completed nonreplies, local execution errors, leading/trailing failures, maximum failure run and observation timestamps. It makes no outage decision. Local execution errors interrupt a failure run rather than masquerading as remote outages. There is no individual successful-ping log, no per-failure HTTP event and no shell execution. A sampling gap resets partial counters.

Complete intervals enter a separate durable outbox before HTTP upload. The outbox is under `Agent:StateDirectory/connectivity/{cabinet-id}`. It uses flushed temporary files and atomic rename, with compiled limits of 14 days, 8 MiB and 8,192 frames, whichever limit is reached first. Uploads contain at most 16 intervals. Acknowledged frames are deleted; ambiguous transport outcomes remain retryable. Age pruning runs on outbox access, not while the agent is stopped or deauthorized. The broader pre-existing check-in spool is separate and unchanged. These connectivity limits do not certify total Agent disk usage.

The server stores the raw aggregate independently of its classification. Three consecutive known failures open one per-link incident. Runs can cross adjacent interval boundaries, but gaps and local execution errors do not extend them. A subsequent successful reply recovers the incident. Missing or older-than-five-minute observations are explicitly stale/unknown, including when an old observation was received recently. Observation, reception, incident detection and recovery observation times remain separate.

Ingestion is transactional under a source-cabinet database write lock. Summary identifiers deduplicate retries. Reusing an identifier with different evidence, overlapping windows, malformed counters, impossible timestamp ordering and unauthorized targets are refused. Older unique evidence is retained without rolling current state back. The server keeps at most 27,000 intervals per source and prunes intervals older than 14 days on that source's next ingestion; an inactive source is not subject to a new background retention sweep in this slice. The read API returns the newest 40 intervals, not the entire retained history.

The WPF Machine tab has a **Same-site connectivity monitoring** panel. It displays the exact target cabinet ID and sync/peer role, classification, stale/unknown status, observation and reception timestamps, last reply, known consecutive failures, incident state and last recovery. The existing dispatcher freshness timer ages this view even without a refresh. Failed detail loads clear previous connectivity rows. Configuration is API-only in this slice; there is no new WPF target editor.

## API and lab setup

Use the existing approved enrollment and HTTPS configuration. Do not change transport validation, shared-secret handling, capability boundaries or firewall configuration to make the demo work. Local test-server HTTP is used only by in-process tests.

1. Enroll and approve the source and targets at the same lab site. Assign the site's sync cabinet through the existing Supervisor topology workflow.
2. Verify each lab target's intended private IPv4 address with the office administrator. The approved address is a pin, not proof of physical network ownership. DHCP reassignment requires an explicit reviewed update. Only canonical RFC1918 IPv4 is accepted. IPv6, public addresses, DNS names, loopback, link-local, multicast and last-octet 0/255 are outside this conservative slice.
3. As an authenticated Supervisor, replace the source's target set:

   `PUT /api/connectivity/cabinets/{source-cabinet-id}/targets`

   ```json
   {
     "reason": "Approved isolated office lab connectivity test",
     "targets": [
       {
         "cabinetId": "00000000-0000-0000-0000-000000000020",
         "address": "192.168.50.20"
       }
     ]
   }
   ```

   Replace the example ID and address with the real registered lab target. The server ignores caller-supplied sync-role assertions. Successful changes are audited with previous and new target sets and a new configuration revision.

4. Agents obtain their own plan through `GET /api/agent/connectivity/plan`; they cannot request another source identity in that URL. Plans refresh every three minutes and expire after ten minutes. A server refusal or invalid plan revokes the cached targets. An uplink failure allows only the remaining lease, after which probing stops rather than using indefinite stale authorization.
5. Agents upload raw interval aggregates through `POST /api/agent/connectivity/summaries`. Support reads `GET /api/connectivity/cabinets/{source-cabinet-id}` or refreshes the Machine tab.
6. To disable, submit the same configuration endpoint with an empty `targets` array and a reason. Agents stop on the next plan refresh, or at lease expiry while disconnected. Revocation is not instantaneous during uplink loss. Old-revision interval uploads are refused and explicitly discarded by the agent rather than reclassified under new targets.

## Manual Windows acceptance, still blocked

Use unused, non-dispensing lab machines and independently available recovery access. Do not run this against production cabinets.

- Confirm no probes or telemetry before enrollment approval, and no ICMP with an empty target set.
- Configure one sync target and up to three registered same-site peers. Observe nominal minute cadence and bounded CPU, memory, disk and network usage on Windows 10 and Windows 11.
- Using an independently approved lab isolation procedure, make one unused target unreachable for at least three probe intervals. Do not blanket-disable Windows Firewall. Confirm one per-link incident rather than a storm of per-ping events.
- Restore that lab path. Confirm actual successful observations resolve the incident while retaining raw failure evidence. A failed ping does not establish firewall causation.
- Interrupt only the test agent's server uplink. Confirm local sampling during the remaining lease, bounded buffering, retry/backoff, replay after recovery, unchanged observation times and correct stale presentation. Confirm probing stops after lease expiry.
- Restart the agent with queued complete summaries. Confirm durable replay and deduplication. Up to two partial samples per target are volatile and can be lost on a crash. Disk-full or spool failures are explicit losses, not fabricated measurements.
- Verify the WPF panel with keyboard navigation, screen reader, high contrast, display scaling and long identities. The panel must never show stale reachability as current health.

## Deliberate limits and release gates

- In the integrated office mode, the production Agent HTTP client uses the persisted per-device credential from [office bootstrap](office-bootstrap.md) for plan retrieval and summary delivery. The matching server binds that credential to its enrolled machine identity and rejects legacy shared keys. Outside that explicitly enabled mode, the legacy shared-secret plus asserted-machine-ID mechanism remains and permits a shared-secret holder to impersonate another machine. Neither mode is **per-device mutual TLS**. Office credential lifetime/revocation limits and tenant-scoped portal authorization remain production blockers.
- The outbox is not encrypted or signed and does not establish administrator-only Windows ACLs itself. Protect the installation and state directories through the separately reviewed packaging process. Power-loss behavior of the directory rename and Windows filesystem remains unverified.
- ICMP reachability is separate from agent-to-server contact, application/database sync success and sync-to-cloud health. This feature does not read a client database or infer those other conditions.
- Incidents are per directed link. Site-wide correlation, sync-incident consolidation, partial site recovery, flapping, operator claims, notification routing and a complete incident workflow are not implemented here.
- Threshold three and stale-after-five-minutes are deterministic server rule v1, not a configuration UI or rule-preview/versioning system. Raw aggregates remain available for future server classification.
- Delayed evidence never rewrites newer current state. Late failure history does not retroactively reopen a recovered link. Ordering depends on observation timestamps, not a device sequence or attested clock.
- Configuration changes reset derived state; old raw evidence remains bounded history. Responses after topology changes filter inactive or moved targets. Cached leases limit, but do not eliminate, the revocation window.
- The existing SQLite dependency advisory and pre-existing Release tests that expect historical maintenance behavior must be dispositioned separately. A green historical maintenance test lane does not approve the Release capability ceiling or authorize publishing that test build.
- Independent review, native Windows acceptance, PostgreSQL concurrency, fleet load/resource measurements and deployment provenance remain separate gates. The existing deployed service was not modified or used as acceptance evidence.

## Rollback

Do not downgrade a running installation as part of a test without authorization. For an approved rollback, first disable target sets and wait for lease expiry, stop the lab agent, and preserve any evidence needed for review. Back up the server database. The new additive migrations are named `ConnectivityConfiguration` and `ConnectivityEvidence` for both SQLite and PostgreSQL. Reverting them drops the new connectivity tables and configuration/state columns and loses that monitoring history; prior cabinet and telemetry tables are not intentionally changed. Never run a migration downgrade against a customer database merely to revert source code. The old server ignores the new routes, and the new agent then has no renewable plan.

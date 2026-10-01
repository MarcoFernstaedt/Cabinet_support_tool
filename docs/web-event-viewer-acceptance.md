# Browser Event Viewer acceptance

The first browser feature is a read-only Command / Inspect surface. The operator should select a cabinet, see collection time and source status, open a channel, choose an event, inspect its exact collected channel/provider/ID/time/message, and narrow the current cabinet's records to a provider. An event is not a live process. Process and service navigation needs separate collected identities and its own reviewed feature; do not invent a process link from provider name or time proximity.

## Verified in local preview source

- The fictional layout preview at `/` remains separate. A cabinet detail link opens a server-rendered saved-result page at `/cabinet/{id}/events`. It reads only the latest `RunEventLogView` action projected by a cabinet-bound Server endpoint, never a generic action response or a newly dispatched action. The projection is limited to 100 entries and 120 KiB, with truncation reported, and the loopback gateway caps upstream JSON at 128 KiB.
- The connected page shows requested channels and provider scope, request time and Agent-reported completion, channel outcomes, explicit pending/failed/partial states, channel and provider drilldowns, and escaped selected-event details. A missing result does not become a fictional or empty successful grid. Server and web synthetic tests cover wrong cabinet, non-event action, malformed or cross-scope result, denial/revocation, partial reads and size bounds.
- Existing fictional preview navigation and hostile-label tests continue to pass. The local gateway checks staff identity on each request and holds the bearer token in server memory; this is not production authentication or cabinet-scoped authorization. No real Agent-to-Server-to-web check or native Windows/browser acceptance has been completed.

## Required before this feature is production-grade

- Use real Entra MFA and map immutable identity to an active Cabinet staff account. Restrict both browser session and each cabinet read to authorized staff. Test revocation and cross-user isolation on the deployed host.
- Validate the narrow bounded projection against real, approved Agent-to-Server transport on disposable Windows 10/11 lab cabinets. Confirm saved-result audit behavior, query plan and latency at representative fleet size. Do not translate denied or partial reads into empty success, and do not expose arbitrary action output or other cabinets through a generic browser proxy.
- Replace the fictional layout preview at `/` with connected-mode navigation only after the real data path and authorization are approved; never mix sample and collected records. Add reviewed action request/queue navigation with delivered, failed, unavailable and stale outcomes as a separately bounded workflow. Label records as historical, not live; keep search scope and result ceiling visible.
- Verify the native Windows 10/11 collection and UI accessibility on disposable lab cabinets, plus the deployed TLS ingress, secure cookie/session persistence, server auditing, threat review and independent QA. The HP is offline, so that acceptance is blocked. A source merge is not a production release.

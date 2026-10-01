# Browser Event Viewer acceptance

The first browser feature is a read-only Command / Inspect surface. The operator should select a cabinet, see collection time and source status, open a channel, choose an event, inspect its exact collected channel/provider/ID/time/message, and narrow the current cabinet's records to a provider. An event is not a live process. Process and service navigation needs separate collected identities and its own reviewed feature; do not invent a process link from provider name or time proximity.

## Verified in this branch

- The synthetic preview has channel counts and click targets, a per-provider drilldown, selected-record details, local search and level filtering. Changing the cabinet resets selection and scoped filters. Text from event fields is inserted as text, not HTML.
- Node tests exercise navigation, stale-selection clearing, cabinet isolation and hostile labels. Desktop and narrow browser checks cover channel/provider drilldown and horizontal overflow.
- The local development gateway guards the preview, checks staff identity against `/api/auth/me`, holds the access token in server memory and refuses network binding. This is not a production authentication boundary.

## Required before this feature is production-grade

- Use real Entra MFA and map immutable identity to an active Cabinet staff account. Restrict both browser session and each cabinet read to authorized staff. Test revocation and cross-user isolation on the deployed host.
- Expose a bounded, read-only event result from the existing Agent to authenticated Server path, with cabinet identity, collection time, requested channels, per-channel read outcomes and truncation metadata. The current `EventLogViewResultDto` is stored on the action result, not a routine event table. Do not translate denied or partial reads into empty success, and do not expose arbitrary action output or other cabinets through a generic browser proxy.
- Replace sample records instead of mixing synthetic and real events. Drive collection/request state through queued, delivered, failed, unavailable and stale outcomes; label records as historical, not live. Keep search scope and result ceiling visible.
- Verify the native Windows 10/11 collection and UI accessibility on disposable lab cabinets, plus the deployed TLS ingress, secure cookie/session persistence, server auditing, threat review and independent QA. The HP is offline, so that acceptance is blocked. No production release or merge to `main` is claimed.

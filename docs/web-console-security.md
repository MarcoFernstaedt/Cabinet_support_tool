# Support Console web transition

Status: architecture decision, not a released web application. The existing WPF Console remains the current diagnostic UI while a browser replacement is reviewed. Neither UI is certified for production by this document. This document does not enable browser access or widen Agent permissions.

## Current source facts

- `src/CabinetPlatform.Server/Program.cs` configures JWT bearer authentication, role policies, token revocation checks and rate limiting. Its startup currently maps API controllers and health checks, not a staff web UI. No MFA, WebAuthn or OIDC staff sign-in workflow was found in this revision.
- `src/CabinetPlatform.Server/Controllers/AuthController.cs` exposes password login and refresh endpoints returning tokens in response bodies. `src/CabinetPlatform.Console.Core/Api/SessionStore.cs` retains access and refresh tokens in the WPF process memory rather than persistent browser storage. Those are desktop assumptions, not a browser-session design.
- The monitoring release allows only selected observational operations. A web page must use the same server-side role and capability ceiling; hiding a button cannot authorize an action.

## Proposed trust boundary

Prefer a same-origin ASP.NET Core browser-facing backend for frontend (BFF) in front of the existing services. Authenticate staff through an organization-approved OIDC identity provider with MFA enforcement, preferably phishing-resistant passkeys or security keys. Do not claim `amr=mfa` or a configured checkbox proves the provider actually enforced MFA; pin the issuer, client, audience and required assurance policy, then test actual sign-in, enrollment, recovery and revocation. Keep API and refresh tokens on the server. Browser sessions use a short-lived, Secure, HttpOnly, SameSite cookie, with idle/absolute limits and logout/revocation. Do not store bearer or refresh tokens in localStorage, sessionStorage or accessible JavaScript cookies. Add CSRF protection to state changes, CSP and output encoding to limit XSS, hardened HTTPS ingress, origin policy, per-role authorization and audited cabinet scope. Keep device Agent credentials and the staff browser identity separate. Decide whether a company IdP exists before implementing this flow; do not bolt an unreviewed TOTP step onto the current password endpoint.

## First release slice

Deliver **one read-only, cabinet-scoped diagnostic**, not a broad UI rewrite: sign in with an MFA-proven staff identity, search/open a cabinet, view a saved event log result, select a row and see its collected channel, provider, time, ID, severity and bounded message. Deny anonymous and wrong-role requests at the server. Prove browser refresh, logout, idle expiry, account deactivation and stale cabinet navigation. Verify keyboard and NVDA behavior, copyable text, high contrast, narrow layout and honest empty/denied/truncated states. Native Agent read and server result limits must remain intact. After this is accepted, add the next diagnostic such as a narrowly authorized read-only file listing. No screen control, remote shell, arbitrary filesystem traversal or disruptive controls are part of this browser milestone.

## Security comparison and release gates

Neither WPF nor a web UI is inherently safer. WPF avoids browser-origin, script and CSRF exposure but currently lacks verified MFA in the source examined. A web Console can centralize updates and MFA, but internet-exposed sign-in and XSS/session vulnerabilities are additional risks. Do not remove the WPF fallback until a threat model, supported IdP, protected ingress, dependency review, penetration/security review, Windows/browser accessibility, revocation tests and an operator acceptance run are complete. Preserve audit, denial, least privilege, data minimization and explicit production approval. This branch may define the migration but cannot claim secure MFA or a finished web app before these checks.

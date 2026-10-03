# Support Console web transition

Status: architecture decision, not a released web application. The browser app is the sole operator Console delivery target and Windows runs the cabinet Agent service. Historical WPF code is not a product fallback or acceptance gate. This document does not enable staff browser access or widen Agent permissions. See [web-only delivery plan](web-only-delivery-plan.md).

## Current source facts

- `src/CabinetPlatform.Server/Program.cs` configures JWT bearer authentication, role policies, token revocation checks and rate limiting. Its startup currently maps API controllers and health checks, not a staff web UI. No MFA, WebAuthn or OIDC staff sign-in workflow was found in this revision.
- `src/CabinetPlatform.Server/Controllers/AuthController.cs` exposes password login and refresh endpoints returning tokens in response bodies. `src/CabinetPlatform.Console.Core/Api/SessionStore.cs` retains access and refresh tokens in the WPF process memory rather than persistent browser storage. Those are desktop assumptions, not a browser-session design.
- The monitoring release allows only selected observational operations. A web page must use the same server-side role and capability ceiling; hiding a button cannot authorize an action.

## Proposed trust boundary

Prefer a same-origin ASP.NET Core browser-facing backend for frontend (BFF) in front of the existing services. Authenticate staff through an organization-approved OIDC identity provider with MFA enforcement, preferably phishing-resistant passkeys or security keys. Do not claim `amr=mfa` or a configured checkbox proves the provider actually enforced MFA; pin the issuer, client, audience and required assurance policy, then test actual sign-in, enrollment, recovery and revocation. Keep API and refresh tokens on the server. Browser sessions use a short-lived, Secure, HttpOnly, SameSite cookie, with idle/absolute limits and logout/revocation. Do not store bearer or refresh tokens in localStorage, sessionStorage or accessible JavaScript cookies. Add CSRF protection to state changes, CSP and output encoding to limit XSS, hardened HTTPS ingress, origin policy, per-role authorization and audited cabinet scope. Keep device Agent credentials and the staff browser identity separate. Use the confirmed Entra tenant only after its app registration and Conditional Access context have been independently verified; do not bolt an unreviewed TOTP step onto the current password endpoint.

## Identity provider update

The support team uses Microsoft 365 work or school accounts with Microsoft Authenticator. The planned provider is therefore the organization's single-tenant Microsoft Entra ID, not a custom TOTP login. `src/CabinetPlatform.WebHost` now implements a fail-closed OIDC authorization-code sign-in boundary with a required tenant authentication-context claim; its tests use only synthetic tenant metadata. The actual tenant, app registration, Conditional Access policy, client credential and staff-to-Cabinet authorization link are not configured or validated here. No staff web access or production MFA claim follows from these tests.

## First release slice

Deliver **one read-only, cabinet-scoped diagnostic**, not a broad UI rewrite: sign in with an MFA-proven staff identity, search/open a cabinet, view a saved event log result, select a row and see its collected channel, provider, time, ID, severity and bounded message. Deny anonymous and wrong-role requests at the server. Prove browser refresh, logout, idle expiry, account deactivation and stale cabinet navigation. Verify keyboard and NVDA behavior, copyable text, high contrast, narrow layout and honest empty/denied/truncated states. Native Agent read and server result limits must remain intact. After this is accepted, add the next diagnostic such as a narrowly authorized read-only file listing. No screen control, remote shell, arbitrary filesystem traversal or disruptive controls are part of this browser milestone.

## Security and release gates

The web Console introduces browser-origin, XSS, CSRF and session risks that must be controlled at the same-origin BFF and Server. Require a threat model, verified IdP assurance, protected ingress, dependency/security review, Windows Agent and browser accessibility tests, revocation tests and an operator acceptance run before staff access. Preserve audit, denial, least privilege, data minimization and explicit production approval. No WPF fallback is required or planned; retiring its delivery path does not waive any web security gate. This source does not claim secure MFA or a finished web app.

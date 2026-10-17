# Readiness report, October 2026

What is proven, what is not, and what you must do before real clinics use it.

## Proven in this repository (tests run on every change)

| Area | Evidence |
|---|---|
| Server and console | 285 server tests, 25 console tests, 0 failing; browser tests drive a real Chromium through sign-in, every page (about 50) and every cabinet tab, and press every read button. |
| Scale | 8,000 simulated cabinets with their own certificates on a 2-core, 1 GB-heap server: 177,332 requests, 0 failed, commands delivered in 6 ms (p50). See `performance.md` for the sizing table. |
| Security | Fixed operation catalog only; no shell, no file transfer; mTLS agents; admin rights only in the broker; every input schema-checked; roles, TOTP for everyone and step-up checked on the server; hash-chained audit log. See `threat-model.md` and `security-review.md`. |
| Supply chain | Image digests pinned, `npm ci --ignore-scripts`, lock files, `npm audit`, SBOM, Dependabot, CODEOWNERS, SECURITY.md, and a test that fails if a pin is removed. See `supply-chain.md`. |
| Accessibility | axe-core (WCAG 2.1 A and AA) runs on every page in both themes and on the welcome tour; zero violations. |
| First sign-in | A role-aware welcome tour starts by itself, outlines every menu item and every cabinet tab, can be left at any time, resumes after a reload, and can be re-run from Account (`first-sign-in.md`). |

## Not proven

- **Real hardware.** The Windows agent code has never run on a real cabinet. The first real-cabinet test (`live-test.md`) comes first.
- **Drive-failure thresholds** are first estimates. They need tuning against real SMART histories.
- **DigitalPersona hardware IDs** and the scanner matching rules need real devices.
- **Release signing certificates / KMS**, **TPM-held agent keys** and an **independent penetration test** are not done.
- `npm audit signatures` could not be verified in the build sandbox; CI runs it.
- Load test used one machine for server, database and load generator; a network between them will add latency (not throughput limits).

## What you must do (outside the code)

1. Run `deploy/pin-actions.sh` so GitHub Actions are pinned to commit hashes.
2. Turn on secret scanning, push protection and branch protection requiring Code Owner review.
3. Provide signing keys (KMS) for release packages; replace the development issuing key.
4. Commission a penetration test before more than a pilot.

## Database

The server uses PostgreSQL (SQL), 25 migrations, about 520 queries written in its dialect. It runs well on a small Linux VM. Moving to Microsoft SQL Server is a rewrite of those queries, the migrations and the test harness (weeks of work, with real risk), so it is not recommended unless policy requires it. Decision for the owner: see the question in the hand-off message.

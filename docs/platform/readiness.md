# Readiness report

What is proven, what is not, and what has to happen outside the code. Rewritten 2026-10-25; the phase list is in
[remaining-phases.md](remaining-phases.md).

## Proven in this repository (tests run on every change)

- **Server and console.** 681 server tests: 672 passing, 0 failing, 9 skipped. The browser tests drive a real Chromium
  through sign-in, every page and every cabinet tab, and press every read button. Console tests run with the console's
  own build.
- **Contracts.** Every one of the 52 operations (34 read, 18 write) has a schema, and both the server and the agent
  refuse an input that does not match it.
- **Scale.** 8,000 simulated cabinets with their own certificates on a 2-core, 1 GB-heap server: 177,332 requests, 0
  failed, commands delivered in 6 ms (p50). See [performance.md](performance.md) for the sizing table.
- **Security.** Fixed operation catalog only; no shell, no file transfer; mTLS agents; administrator rights only in the
  broker; every input schema-checked; roles, TOTP for everyone and step-up checked on the server; hash-chained audit log.
  See [threat-model.md](threat-model.md) and [security-review.md](security-review.md).
- **Supply chain.** Image digests pinned, `npm ci --ignore-scripts`, lock files, `npm audit`, SBOM, Dependabot,
  CODEOWNERS, SECURITY.md, and a test that fails if a pin is removed. See [supply-chain.md](supply-chain.md).
- **Accessibility.** axe-core (WCAG 2.1 A and AA) runs on every page in both themes and on the welcome tour; zero
  violations.
- **First sign-in.** A role-aware welcome tour starts by itself, outlines every menu item and every cabinet tab, can be
  left at any time, resumes after a reload, and can be re-run from Account ([first-sign-in.md](first-sign-in.md)).
- **A live platform**: the deployment on the VPS runs both archives with checksums, and the console is reachable through
  the portfolio site's proxy.
- **A real Windows machine, reads only (2026-10-25).** The agent was installed read-only on a real machine, self-updated
  from 0.2.4 to 0.2.5, and answered **19 of the 34 read operations** with the machine's own data. **15 read operations
  answered `unavailable`** — the operations whose implementations live outside the broker's network registrar, so they are
  the next thing to check on Windows. **No write ran**: the read-only mode refused the one write that was tried, which
  proves the guard rather than the writes. The agent was then uninstalled (services, program files, data and machine key)
  and the cabinet revoked; the console shows no cabinets. Details in [live-test.md](live-test.md).
- **Both architectures**: `windows-x64` and `windows-x86` are built from the same source, share version, operations and
  signing, and an agent refuses a package built for the other architecture (proven live).

## Not proven

- **Writes on real hardware.** No writing operation has ever run on a real cabinet. The read path is proven; the write
  path has only ever run against the standalone harness.
- **The 15 `unavailable` reads** above, which need a real machine to explain each one.
- **Drive-failure thresholds** are first estimates; they need tuning against real SMART histories.
- **DigitalPersona hardware IDs** and the scanner matching rules need real devices.
- **The paths that only matter in the field**: cabinets on their own network talking to the platform over the site link,
  a real site's sync cabinet, and the PowerShell and Windows-version coverage in
  [windows-coverage-review.md](windows-coverage-review.md).
- **Release signing certificates / KMS**, **TPM-held agent keys** and an **independent penetration test** are not done.
- `npm audit signatures` could not be verified in the build sandbox; CI runs it.
- The load test used one machine for server, database and load generator; a network between them adds latency (not a
  throughput limit).

## What must happen outside the code

1. Run `deploy/pin-actions.sh` so GitHub Actions are pinned to commit hashes.
2. Turn on secret scanning, push protection and branch protection requiring Code Owner review.
3. Provide signing keys (KMS) for release packages and replace the development issuing key.
4. Commission a penetration test before more than a pilot.

## Database

The platform database is **Microsoft SQL Server 2022**, holding the support team's accounts, fleet records, alerts and
activity logs. It is never the cabinet application's database. The port from PostgreSQL is done and documented in
[sqlserver-port.md](sqlserver-port.md); the earlier assessment that recommended staying on PostgreSQL is retired.

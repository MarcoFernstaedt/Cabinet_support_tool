# Bounded office bootstrap

This prepares a **private, unsigned staging bundle**, not a customer installer. Distribution is blocked. It does not install a Windows service, contact the server, approve a cabinet, alter the running test service, or change the compiled monitoring boundary. The Agent and WPF Console use the same reviewed endpoint:

`https://srv1522777.tail72f980.ts.net/`

The original specification requires unique enrollment (§13), no shared install key (§16), mutual TLS and protected storage (§17), and Windows compatibility evidence (§43). This office implementation addresses unique enrollment and automatic configuration. It does **not** certify the other requirements or the 8,000-cabinet architecture.

## Generate once, configure each device without editing JSON

Run on the authorized Linux build host, outside the repository and outside a public downloads directory:

```sh
python3 tools/prepare_office_demo.py \
  --output /home/marco/tmp/cabinet-office-staging-NEW \
  --devices 2 \
  --dotnet /home/marco/tmp/cabinet-audit-dotnet/dotnet
```

The output parent must already exist and be controlled by the operator. The output must not exist. There is no overwrite switch. The generator publishes **Release**, self-contained `win-x64` Agent and Console artifacts with `-m:1`, then replaces their deployment configuration with one endpoint. `LegacyMaintenanceTests` is never a packaging choice. `--config-only` exercises configuration generation without binaries and remains blocked for distribution.

Output:

| Path | Purpose |
| --- | --- |
| `agent/` | Generic Agent binaries and generated `appsettings.json`; no baked device identity or fleet key |
| `console/` | WPF Console binaries and generated `appsettings.json`; no operator credentials |
| `enrollment/device-001.json`, etc. | One distinct secret token per intended office device |
| `server/office-enrollment.json` | Office-mode configuration containing token hashes only |
| `server/grants.json` | Initially empty, private, durable consumed-token journal |
| `manifest.json` | Source commit, dirty-source flag, artifact SHA-256, endpoint, unsigned status and distribution blockers |
| `build-logs/` | Actual publish output |

All output directories are owner-only and files owner-readable/writable on Linux. Token values are never printed. The generator rejects other endpoints, cleartext, URL credentials, path/query/fragment additions, output inside the checkout, existing output, and device counts outside 1–10. Generate another batch only through an operator-reviewed enrollment inventory procedure; do not replace an active server manifest/journal with a fresh batch. The current generator creates a new lab, not an incremental fleet enrollment administrator.

A token expires after **20 minutes** if unused. A device credential expires **24 hours after bundle generation**, not 24 hours after first use. Generate tokens shortly before the authorized lab session. The server accepts at most 100 retained grants, at most a 30-minute unspent-token window and at most seven days of device validity. No automatic renewal or journal pruning is implemented.

## Server activation is a separate, blocked deployment gate

The running test service was not upgraded by this work. Its health response is not a protocol or security-version negotiation. Do not hand out a shared agent key to make new agents work against an old server.

After independent review and separate authorization for the exact test-service deployment:

1. Publish the matching server revision in **Release**, preserving the existing support database, secrets and rollback copy. There is no database schema change for office enrollment.
2. Keep the generated journal at its absolute `StateFile` path, on a local disk owned by the service operator. Keep its directory mode `0700` and files `0600`. Do not put it on a shared/network filesystem. Do not recreate, truncate or restore an earlier journal after use.
3. Place the generated `server/office-enrollment.json` in the server's content root. The server reads this optional companion before environment and command-line overrides. It does not hot reload.
4. **Independently pin `OfficeEnrollment__Enabled=true` in the test service environment.** This is required so loss of the companion file cannot silently return the deployment to legacy authentication. With this flag, missing configuration/journal prevents startup. Remove the legacy shared key from the office deployment rather than retaining it as a recovery mechanism.
5. Retain loopback-only HTTP binding behind a reviewed HTTPS terminator. The application does not itself supply a TLS terminator or trust arbitrary forwarded headers. Confirm the intended public/private access policy; a Funnel is not a tailnet-only access control.
6. Restart only the explicitly authorized test service, then verify the actual binary provenance, anonymous denial, rejection of the old shared key, one-device token binding, pending approval and an authenticated Console readback. No such restart or live enrollment has been performed here.

When office mode is enabled, there is **no shared-key fallback**. A missing, corrupt, oversized or concurrently owned journal is a startup failure. The journal has an exclusive process lock, so this implementation supports one server process only. A new token cannot take over an existing cabinet or pending registration from the legacy identity system. Migration and credential renewal require a separate design, not deletion of historical records.

## Windows preparation and verification still required

There is deliberately no automatic installer or service-start script in this change. Native Windows 10/11 execution, ACL enforcement, signature verification and service recovery have not been verified on this Linux host.

Before any authorized disposable Windows lab run, the operator must verify the artifact hashes over a trusted transfer path and explicitly resolve the unsigned-artifact gate. SHA-256 is integrity bookkeeping, **not a code signature**. Never call these binaries signed or use them for agent self-update.

After those gates are resolved:

1. Put the generic Agent package in its intended administrator-owned installation directory. Do not use Downloads, a user-writable application directory or a network share for a LocalSystem service.
2. Ensure the installation directory and its runtime/credential files are writable only by Administrators and SYSTEM, and the credential directory is readable only by those identities. Verify effective inherited permissions, not merely an `icacls` exit code. The generated Linux file mode does not establish Windows ACLs.
3. Transfer exactly one intended `enrollment/device-NNN.json` through the approved private channel and place it beside the agent executable as `office-enrollment.json`. No per-machine JSON editing is needed. Never reuse this token file on a second machine or image an enrolled installation.
4. Use the generic Console package unchanged. Sign in with a named test operator account; the generator supplies no username, password or session token.
5. Perform the separate service installation/recovery checklist in `agent-install.md` only after native approval. Until then the package is staging, not an install recommendation.
6. Confirm the expected pending machine in the Console's registration queue, independently verify its identity/site and approve it. Enrollment alone never grants monitoring access or approves a cabinet.
7. Reboot/restart in the lab, verify the same identity persists, inspect the latest check-in through the Console and test denial from a different machine/key. Verify cleanup and revocation on decommissioning.

The agent persists a fresh random device key before calling the enrollment endpoint. It submits the one-use token, machine identity and this key over ordinary certificate-validated HTTPS. The server stores only hashes and atomically binds the token to one machine/key pair before returning HTTP 204. A response lost after commit can be retried only with that exact pair, even after the unused-token deadline, until the device deadline. Neither a token alone, a changed machine id nor a changed key can recover the credential. The agent then marks its local journal confirmed and removes the original token file. The live key journal is `office-enrollment.json.device`; it is secret and must retain the protected directory ACL.

Both enrollment and authenticated Agent requests reject another origin and disable redirects. The Console validates an HTTPS origin before login and disables redirects. HTTP client header logs are redacted, including trace-level logs. No custom certificate acceptance callback is installed. The anonymous enrollment surface has a fixed server-wide limit of 20 attempts per minute, no queue and a 2 KiB request limit; rotating caller-supplied machine headers cannot bypass it.

## Revocation and rollback

Remove the device's token-hash entry from the office manifest and perform a separately authorized test-service restart to revoke its device credential. Preserve the consumed journal entry. Deactivate the cabinet through the existing supported administration path as well; credential revocation and cabinet retirement are different operations. Revocation is **not instantaneous without restart** in this bounded implementation. The time limit remains enforced on every authenticated request.

For an unused staging bundle, remove its private directory after the operator confirms it was never activated. For a used lab, preserve the journal and audit evidence and revoke before deleting device credentials. Do not copy a confirmed key journal to a replacement drive. Do not restore an empty or earlier journal, extend expired tokens by changing their issue time, or fall back to the shared fleet key. A code rollback must keep access closed until an explicitly reviewed identity-compatible server is available. The old shared-key server is not a safe automatic rollback target for this mode.

## Remaining security gates

- Native Windows 10/11 service, ACL, WPF, TLS and uninstall/revocation acceptance.
- Signed artifacts and a verified installer/update chain.
- Independent review/QA and an authorized matching-server deployment.
- Mutual TLS, cabinet-side encrypted credential storage, protected/signed telemetry buffers and a split-privilege agent architecture.
- Multi-process/fleet enrollment storage, atomic support-database/credential journaling, token inventory administration, immediate revocation, renewal, cloning detection and tamper-evident enrollment audit.
- Power-loss and filesystem rollback testing. `Flush(true)` plus atomic replacement and a retained journal prove process/retry behavior in tests, not directory-entry durability through every power loss or restoration of an old disk snapshot.
- Staff MFA, tenant-isolation and the wider production specification. Existing platform limitations are not fixed by unique enrollment.

No client database access, scripts or sensor integrations are added. The shipping Release allowlist remains the existing four observation actions.

# Moving the platform

Preserve identity and data. Keep the old host available for rollback, stop writes during the final snapshot, and allow only one writer after cutover. Do not run setup.sh as a migration procedure.

## What travels

Transfer the verified encrypted SQL backup, separately held /root/.cabinet-backup-key, complete cabinet_pki, cabinet_packages and cabinet_releases volumes, and the protected env file including CONSOLE_SECRET_KEY. The volumes mount at /var/lib/cabinet/pki, /var/lib/cabinet/packages and /var/lib/cabinet/releases. Preserve ownership (server UID/GID 10001), permissions and contents. Transfer local Compose/Caddy overrides privately and review host-specific addresses. Neither archives nor secrets belong in git. The nightly script backs up SQL only.

Record the repository revision, application image ID/digest, agent build settings and trust manifests. Pin the destination to the same application image and schema, SQL Server 2022 CU27-GDR1 digest and Caddy digest from compose.yaml. Export/import the built cabinet-platform image if necessary: rebuilding :local can change inputs. Keep the same SQL edition initially. Do not combine the move with dependency or schema upgrades.

Containers, networks and logs may be regenerated. Caddy data/config and console certificates may be regenerated when ACME/private trust prerequisites are available. SQL logins must be recreated with preserved passwords. The issuing CA and off-host release/approved-list signing keys are identities, not disposable configuration.

## Order

1. Record cabinet IDs/counts, last heartbeats, schema version, audit verification result, CA fingerprint and package/release hashes. Quiesce the old app, run backup.sh, retain its successful verification/encryption log, archive the file volumes privately and verify backup decryption with the off-host key.
2. Start only mssql on the destination using the protected env. Restore SQL using README.md's Restore commands, leaving the app stopped. Use the identical app image's migrate service to recreate the app login/grants. If the restored user is orphaned, run ALTER USER [cabinet_app_login] WITH LOGIN = [cabinet_app_login] as sa in cabinet. Compare schema versions before accepting any migration.
3. Restore PKI, packages and releases before starting the app. Compare CA fingerprint and store hashes against baseline; retain permissions. Never start the app with an empty pki volume during a move.
4. Start the same app image and Caddy with reviewed host overrides. Verify data and health before changing DNS.
5. Confirm certificate names. AGENT_API_HOSTNAMES lists exactly the names/IPs the development TLS certificate covers. AGENT_PUBLIC_HOST (or the first list entry) must be covered AND reachable from cabinet networks. AGENT_PUBLIC_PORT defaults to 8443. Retaining existing names and PKI is least disruptive. On restart, the development certificate code regenerates the server certificate when its saved hostname list differs. This preserves the issuing CA. Inspect actual served SANs before cutover.
6. Switch DNS/routing, then observe existing agents reconnect using their existing identities/certificates. Check last heartbeats, commands and audit verification. Install the backup schedule with install-backup-cron.sh and test it on the destination.

## Proof

Run from deploy/ using the same environment and overrides as startup. This host's cabinet-compose-local wrapper reads the root-owned env; on a new host use the explicit docker compose command in env/README.md instead. The wrapper is host tooling, not part of the repository.

    cabinet-compose-local ps
    cabinet-compose-local port server 8443
    cabinet-compose-local exec -T server printenv AGENT_API_HOST AGENT_API_PORT DEV_PKI_DIR PACKAGE_DIR RELEASE_DIR
    cabinet-compose-local exec -T server node -e "fetch('http://127.0.0.1:8080/api/health').then(async r => { console.log(r.status); console.log(await r.text()); process.exit(r.ok ? 0 : 1) })"
    cabinet-compose-local exec -T server node /opt/cabinet/server/dist/src/cli.js
    cabinet-compose-local exec -T server node /opt/cabinet/server/dist/src/cli.js audit-verify
    cabinet-compose-local exec -T mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -d cabinet -Q "SELECT version, checksum FROM schema_migrations ORDER BY version; SELECT id FROM cabinets ORDER BY id; SELECT COUNT(*) AS cabinets FROM cabinets"'
    bash backup.sh --print-plan

Expect healthy mssql/server, running Caddy and migrate exited 0; health must return 200. CLI without arguments lists the available commands for this pinned version. audit-verify must print "Audit chain intact: N entries." with the baseline entry count before writes resume. SQL must return identical migration versions/checksums and cabinet IDs/counts on both hosts. The CA certificate is pki/dev-issuing-ca.cert.pem within the preserved volume. Compare schema and audit verification using those operator commands and database catalog queries with the recorded baseline; compare cabinet IDs/counts and heartbeat recency in the console. Health alone does not establish identity. Compare CA fingerprint and complete store hashes too.

AGENT_BIND_IP decides the host agent API binding. The exact proof is cabinet-compose-local port server 8443: expect 0.0.0.0:8443 by default, or the selected host address followed by :8443. Inside the image AGENT_API_HOST=0.0.0.0 and AGENT_API_PORT=8443; printenv must show these followed by the three /var/lib/cabinet paths. The internal listener and published host binding are separate.

From a cabinet network run openssl s_client -connect <agent-host>:8443 -servername <agent-host> -CAfile <preserved-ca-certificate> -verify_return_error, inspecting SANs and expecting certificate verification success. Fetch HTTPS /health using the same CA: expect HTTP 200. Authenticated routes still require the existing cabinet client certificate. Compare openssl x509 -in <ca-certificate> -noout -fingerprint -sha256 on both hosts. Replace angle-bracket placeholders with actual names and public certificate paths.

Generic Caddy ports are 80/443 TCP and 443 UDP; SQL 1433 is not published. This VPS replaces Caddy bindings with 127.0.0.1 because Tailscale holds public 443. Carry that override only if the destination has the corresponding proxy route.

## One-way doors

A new PKI means every cabinet must be re-enrolled. Losing CONSOLE_SECRET_KEY makes sealed authenticator secrets unreadable. Losing the backup key makes encrypted backups unreadable. Missing store files leaves database metadata pointing to absent bytes. Schema upgrades can prevent application rollback; retain pre-upgrade backups and do not upgrade during the move. Once the destination accepts writes, reverting DNS to the old database loses those writes unless reconciled.

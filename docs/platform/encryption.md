# Encryption: in transit, at rest and in exports

What is encrypted, where, and what to do about the one gap: SQL Server Express cannot encrypt its own data files (transparent data encryption needs Standard). The fix below is more secure than switching editions and costs nothing.

| Data | Protection | Status |
|---|---|---|
| Agent to server | Mutual TLS 1.2+ with a certificate per cabinet; the server checks the certificate on every request and drops a revoked one at once | Built |
| Console to server | HTTPS (Caddy), `__Host-` HttpOnly Secure SameSite=Strict cookie, strict CSP | Built |
| Server to database | Encrypted connection to SQL Server (`encrypt=true`). In the deployment kit the server certificate is not verified (`trustServerCertificate=true`) because the database is only reachable on the private compose network | Built; verify the certificate if the database is ever on another machine |
| Passwords and authenticator secrets | Password hashes only; authenticator secrets sealed with a server key; no secret in logs | Built |
| Database backups | AES-256 (gpg), key in `/root/.cabinet-backup-key`, plain copies deleted, `RESTORE VERIFYONLY` first | Implemented (`deploy/backup.sh`); Express omits compression. Install cron with `deploy/install-backup-cron.sh` and verify a successful backup |
| **Live data files** (database, CA private key, packages, releases) | **Encrypt the volume that holds them**; see below | Do at install |
| Evidence package exports | Optional passphrase encryption (AES-256-GCM, scrypt key) | See "Encrypted exports" |

## Encrypting the data at rest

Disk encryption protects the database, the development CA's private key, the software library and releases together. TDE would protect only the database, so this is the stronger choice.

1. **Provider volume encryption** (easiest): choose an encrypted volume or disk when creating the VPS, or enable it in the provider's console. Most providers offer it at no cost.
2. **LUKS on the data volume** (any provider): create the volume encrypted, mount it at `/var/lib/docker/volumes` (or the path the compose volumes live on), and keep the passphrase off the server. The machine needs the passphrase after a reboot, which also means a stolen disk or snapshot is unreadable.
3. Keep the **backup key off the server** (already documented) and the **`pki` volume** backup private.

Check with `lsblk -f` that the data volume's type is `crypto_LUKS` (or the provider shows encryption on).

## Encrypted exports

Evidence packages (what the platform holds about one cabinet for a period) can be exported encrypted with a passphrase the Admin or technician chooses, so the file is safe to email to a vendor or keep in a ticket. On a cabinet's Crashes and restarts tab, **Download encrypted** asks for a passphrase of 12 to 128 characters and downloads a `.cabev` file (AES-256-GCM, key from the passphrase with scrypt, any changed byte makes it refuse to open). The export is recorded in the audit log with the package hash and the fact that it was encrypted; the passphrase is sent in the request body once and never stored or logged. To open a file: `EVIDENCE_PASSPHRASE=... node deploy/decrypt-evidence.mjs file.cabev > evidence.json` (needs only Node). Share the passphrase by another route than the file.

## What encryption does not do

It does not protect a signed-in console session, and it does not replace role checks. Everything the console shows is still decided on the server by role.

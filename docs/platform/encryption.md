# Encryption: in transit, at rest and in exports

What is encrypted, where, and what to do about the one gap: SQL Server Express cannot encrypt its own data files (transparent data encryption needs Standard). The fix below is more secure than switching editions and costs nothing.

| Data | Protection | Status |
|---|---|---|
| Agent to server | Mutual TLS 1.2+ with a certificate per cabinet; the server checks the certificate on every request and drops a revoked one at once | Built |
| Console to server | HTTPS (Caddy), `__Host-` HttpOnly Secure SameSite=Strict cookie, strict CSP | Built |
| Server to database | TLS to SQL Server inside the compose network | Built |
| Passwords and authenticator secrets | Password hashes only; authenticator secrets sealed with a server key; no secret in logs | Built |
| Database backups | AES-256 (gpg), key in `/root/.cabinet-backup-key`, plain copies deleted, `RESTORE VERIFYONLY` first | Built (`deploy/backup.sh`) |
| **Live data files** (database, CA private key, packages, releases) | **Encrypt the volume that holds them**; see below | Do at install |
| Evidence package exports | Optional passphrase encryption (AES-256-GCM, scrypt key) | See "Encrypted exports" |

## Encrypting the data at rest

Disk encryption protects the database, the development CA's private key, the software library and releases together. TDE would protect only the database, so this is the stronger choice.

1. **Provider volume encryption** (easiest): choose an encrypted volume or disk when creating the VPS, or enable it in the provider's console. Most providers offer it at no cost.
2. **LUKS on the data volume** (any provider): create the volume encrypted, mount it at `/var/lib/docker/volumes` (or the path the compose volumes live on), and keep the passphrase off the server. The machine needs the passphrase after a reboot, which also means a stolen disk or snapshot is unreadable.
3. Keep the **backup key off the server** (already documented) and the **`pki` volume** backup private.

Check with `lsblk -f` that the data volume's type is `crypto_LUKS` (or the provider shows encryption on).

## Encrypted exports

Evidence packages (what the platform holds about one cabinet for a period) can be exported encrypted with a passphrase the Admin or technician chooses, so the file is safe to email to a vendor or keep in a ticket. The export route records the export, the package hash and the fact that it was encrypted in the audit log; the passphrase is never stored or logged.

## What encryption does not do

It does not protect a signed-in console session, and it does not replace role checks. Everything the console shows is still decided on the server by role.

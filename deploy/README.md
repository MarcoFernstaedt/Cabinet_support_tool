# Demo deployment

This folder runs the platform on one Linux VPS for a demo: Microsoft SQL Server 2022, the server (agent API and console API), the console, and Caddy for HTTPS. It also builds the Windows agent, so you can install it on a laptop that connects over the internet.

This is a demo setup. It uses the development certificate authority. Do not connect real cabinets to it.

## What runs

| Service | What it does | Port on the VPS |
| --- | --- | --- |
| `caddy` | HTTPS for the console. Gets a certificate for your domain automatically. | 80, 443 |
| `server` | The agent API (mutual TLS) and the console. | 8443 (agent API) |
| `mssql` | The database (SQL Server 2022 for Linux). Not reachable from outside. | none |
| `migrate` | Runs once at each start. Creates the database, updates its schema and the app's database login. | none |

The agent API on port 8443 is published directly, not through Caddy. Agents sign in with client certificates, and those must reach the server itself. A caller without a certificate still completes the TLS handshake, but it can reach only the health check and the two enrollment routes (enrolling needs a one-time bootstrap token); every other route refuses it.

On this VPS the local override binds Caddy to 127.0.0.1:80/443 because Tailscale holds public 443. The table describes the generic deployment. AGENT_BIND_IP controls the published agent binding.

For the protected root-owned deploy/.env on this host, run cabinet-compose-local in deploy/ in place of docker compose. It reads the protected env for Compose. Include the override explicitly when passing -f. See [env/README.md](env/README.md) for environment selection and [PORTABILITY.md](PORTABILITY.md) for moving hosts.

## Prerequisites

1. A VPS with Ubuntu 24.04, 2 CPUs, 4 GB memory and 20 GB disk.
2. Docker with the Compose plugin. To install it: `curl -fsSL https://get.docker.com | sh`
3. A domain is recommended, for example `cabinets.example.com`. Point its DNS A record at the VPS's IP address. Without a domain, the console uses the IP address and the browser shows a certificate warning.
4. Ports 80, 443 and 8443 (TCP) open in your provider's firewall.

## Set up

1. Copy the repository to the VPS: `git clone <repository> && cd Cabinet_support_tool`
2. Run `sudo bash deploy/setup.sh`
3. Answer the questions: the VPS's public IP, your domain (or leave it empty), and the first Admin's username and name.
4. Write down the temporary password it prints. It is shown only once.

The script:
- checks Docker;
- writes `deploy/.env` with random secrets (only if it does not exist yet);
- opens ports 80, 443 and 8443 if `ufw` is active, and prints each rule;
- builds the image, starts Microsoft SQL Server, runs the migrations and starts the rest;
- creates the first Admin if there is none.

You can run it again at any time. It keeps `deploy/.env` and the data.

## Sign in

1. Open `https://<your domain>` (or `https://<IP>`).
2. With an IP only, the browser warns about the certificate. Continue past the warning.
3. Sign in with the Admin username and the temporary password.
4. Choose a new password.
5. Set up an authenticator app (for example Google Authenticator or Microsoft Authenticator) when asked. Approvals and changes need a code from it.

## Install the agent on a cabinet

Works on Windows 10 (1607 or later) and Windows 11, 32-bit and 64-bit, with the Windows PowerShell 5.1 every machine has.

1. In the console, as an Admin, open **Admin → Setup**.
2. Download the agent: the 32-bit and the 64-bit package (keep both if your cabinets are mixed).
3. Press **Create installer** and confirm with your authenticator code. You get `Install-CabinetAgent.cmd` for one cabinet: it carries this server's address, its CA and a one-time token (valid 7 days).
4. On the cabinet, put the installer next to the package(s) (Downloads or a USB stick) and double-click it. Approve the Windows prompt. It picks the package for that Windows, checks it against the server, installs, and deletes itself.
5. Approve the cabinet in the console under **Pending cabinets**.

The address in the installer is `AGENT_PUBLIC_HOST`, or the first name in `AGENT_API_HOSTNAMES` (`deploy/.env`).

The agent is a developer build and is not signed. Windows SmartScreen or Defender may warn about it.

### Development cabinet updates — never use on a production cabinet

A normal agent without a pinned code-signing publisher refuses upgrades even when the release manifest is signed. For a
disposable test fleet, build its initial agent with `--build-arg ALLOW_UNSIGNED_DEVELOPMENT_UPGRADES=true` and an explicit
`AGENT_VERSION` (or `-p:AllowUnsignedDevelopmentUpgrades=true` for each `dotnet publish`). Install this build manually
once: a previously installed strict agent cannot be switched remotely. Every subsequent package still needs a manifest
signed with the release key compiled into the agent, plus the matching whole-ZIP SHA-256, a higher version, an allowed
archive layout and the required programs. Only the Authenticode publisher check is relaxed when there is no publisher.
The server and heartbeat cannot enable this mode, and the build default is false. Test an update and a failed update
with a pilot before relying on remote recovery; retain physical access until then.

## Sign the approved programs list

Only programs on the approved list can be started, stopped, restarted or ended on a cabinet. Once list signing is set up, a list goes into force only after an Admin signs it on their own computer. A cabinet then refuses any list that is not signed with your key, even if someone tampers with the copy on the cabinet. Until it is set up, lists apply as soon as they are saved.

**Set it up once.** You need PowerShell 7 on the Admin's computer (`winget install --id Microsoft.PowerShell`).

1. Make the key, kept on a USB stick that stays with the Admin:
   ```
   pwsh agent/install/New-ApprovedListTrust.ps1 -NewKey E:\list-signing-key.pem -OutDir contracts/trust/approved-list
   ```
   - The script asks for a passphrase of at least 12 characters, and writes only the public key into the repository.
   - Keep a second copy of the key file somewhere safe.
   - A cloud key works too: `-AwsKmsKeyId alias/...`, or `-PublicKeyFile` with an Azure Key Vault key.
2. Commit `contracts/trust/approved-list/approved-list-keys.json` through review.
3. Build and roll out the agent from that commit.

   Cabinets on that agent approve nothing until their list is signed. Sign the lists already in force (below) when you roll it out.

**Each time a list changes:**
1. In Admin → Approved programs, change the list and save it with your authenticator code. The page says "Version N is waiting for your signature". The list already in force stays in force.
2. Select **Download the list to sign**.
3. Sign the file on your computer:
   ```
   pwsh agent/install/Sign-ApprovedList.ps1 -ListFile approved-list-site-....json -KeyFile E:\list-signing-key.pem
   ```
   The script shows every program on the list. Type `SIGN` to confirm.
4. Select **Upload the signature file** and choose the `.signature.json` file the script wrote. Cabinets use the list from their next check-in.

## Everyday commands

Run these in the `deploy` folder.

| Task | Command |
| --- | --- |
| See status | `docker compose ps` |
| Server log | `docker compose logs -f server` |
| Operator tool | `docker compose exec server node /opt/cabinet/server/dist/src/cli.js <command>` (run without a command for the list) |
| Stop | `docker compose down` (keeps all data) |
| Start again | `docker compose up -d` |

## Update

1. `git pull`
2. `cd deploy && docker compose up -d --build`

The `migrate` service runs before the server starts and applies only new migrations.

## Back up

`setup.sh` calls `install-backup-cron.sh` to install a nightly job (`/etc/cron.d/cabinet-backup`, 02:17) that runs `deploy/backup.sh`:

- `BACKUP DATABASE` inside the SQL Server container (with checksums; compression on Developer, Standard and Enterprise, never Express), then `RESTORE VERIFYONLY`;
- the backup is encrypted with the key in `/root/.cabinet-backup-key` (AES-256) and every plain copy is deleted;
- the last 14 are kept in `/var/backups/cabinet`; set `BACKUP_TARGET` (an rsync destination on another machine) in the cron line to copy each one off the server.

Install or repair cron with `sudo bash deploy/install-backup-cron.sh`; non-root runs print the exact line and change nothing. The command sets PATH explicitly. backup.sh reads Compose credentials from deploy/.env, not sourced shell variables. Failures exit non-zero with one sentence naming the failed step and log (default /var/log/cabinet-backup.log). `bash deploy/backup.sh --print-plan` queries the edition without writing a backup. Schedule installation does not prove that a backup succeeded: run and verify one.

Copy `/root/.cabinet-backup-key` somewhere safe off the server once: without it no backup can be read. Run a backup now with `sudo deploy/backup.sh`.

The database uses the SIMPLE recovery model, so its log never grows without bound; the recovery point is the last nightly backup.

The development CA and the stores (the CA's private key is in `pki`; keep the backup private):

```sh
docker run --rm -v cabinet_pki:/pki -v cabinet_packages:/packages -v cabinet_releases:/releases -v "$PWD":/backup \
  debian:bookworm-slim tar czf /backup/cabinet-files-$(date +%F).tgz /pki /packages /releases
```

To restore the database, stop the server, then:

```sh
cd deploy
gpg --decrypt --passphrase-file /root/.cabinet-backup-key --batch /var/backups/cabinet/cabinet-<stamp>.bak.gpg > /tmp/cabinet.bak
docker compose stop server
docker compose cp /tmp/cabinet.bak mssql:/var/opt/mssql/data/cabinet.bak && rm /tmp/cabinet.bak
docker compose exec -T mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" \
  -Q "ALTER DATABASE cabinet SET SINGLE_USER WITH ROLLBACK IMMEDIATE; RESTORE DATABASE cabinet FROM DISK = N'"'"'/var/opt/mssql/data/cabinet.bak'"'"' WITH REPLACE, CHECKSUM; ALTER DATABASE cabinet SET MULTI_USER"; rm -f /var/opt/mssql/data/cabinet.bak'
docker compose up -d
```

Without the `pki` backup, restored cabinets cannot connect: their certificates were issued by the old CA. Test a restore on a spare machine once a month.

## Reset the demo

This deletes the database, the CA, the stores and Caddy's certificates. `deploy/.env` is kept.

1. `cd deploy && docker compose down -v`
2. `sudo bash setup.sh`
3. On each laptop, remove the old agent: `.\install\Uninstall-CabinetAgent.ps1 -RemoveData`. Then install it again with a new token and the new CA certificate.

To also change the names or secrets, delete `deploy/.env` before step 2.

## Local overrides

`compose.yaml` is generic and holds nothing specific to one machine. Anything local goes in files git ignores:

- `deploy/.env`: names, addresses, secrets, and the optional switches `CONSOLE_BASE`, `CONSOLE_ORIGIN`, `AGENT_BIND_IP`, `CONSOLE_BIND_IP`, `AGENT_PUBLIC_HOST`, `AGENT_PUBLIC_PORT` and `ALLOW_UNSIGNED_DEVELOPMENT_UPGRADES`.
- `deploy/compose.override.yaml`: changes to the services themselves. Docker Compose reads it automatically next to `compose.yaml`, and `setup.sh` passes it too.
- `deploy/Caddyfile.local`: a different console front, mounted by the override.

`deploy/examples/tailnet/` is a worked example for a console reached through Tailscale Serve or Funnel, with an optional front on another domain. To turn it off again, delete `deploy/compose.override.yaml` and run `docker compose up -d`.

## Security notes

- **Demo CA only.** The server issues agent certificates with a development CA, whose private key lives in the `pki` volume on the VPS. Production uses a CA key held in a KMS, and a real TLS certificate for the agent API (`AGENT_TLS_CERT_FILE`, `AGENT_TLS_KEY_FILE`). The server refuses the development CA when `NODE_ENV=production`, so this image does not set it.
- **Ports.** Only 80, 443 and 8443 are published. Never publish Microsoft SQL Server (1433). It sits on an internal Docker network with no route out.
- **The console** is meant to sit on an internal network or VPN. Set `CONSOLE_ALLOW_FROM` in `.env` to your office and VPN ranges (CIDR, space-separated) and run `docker compose up -d`: everyone else gets 403. The default allows everyone, for a first demo only. HTTPS is enforced with HSTS on a domain.
- **Sign-in limits** count each browser's address, which Caddy passes to the server. A proxy in front of Caddy must be listed in `CONSOLE_TRUSTED_PROXIES` (see `deploy/examples/tailnet/`), or everyone behind it shares one address. Past the address limit, a browser that has fully signed in to that account before (password and authenticator code) can still sign in.
- **Secrets** are in the selected ignored real env file under `deploy/` (mode 600). It is ignored by git. Never commit or share it.
- **Docker and ufw.** Ports Docker publishes bypass `ufw`. Control access with your provider's firewall.
- **The agent zip** is an unsigned developer build. Never install it on a production cabinet.
- **Unsigned development upgrades** (`ALLOW_UNSIGNED_DEVELOPMENT_UPGRADES=true`) are off by default. When on, the agents the image builds trust the release key alone, with no code-signing publisher, so whoever holds that key can push code to every cabinet. Keep the release private key off the server host, and never turn this on in production.
- The server runs as a non-root user with a read-only file system. The database login it uses (`cabinet_app_login`) holds only the `cabinet_app` role.

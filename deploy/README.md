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

The agent API on port 8443 is published directly, not through Caddy. Agents sign in with client certificates, and those must reach the server itself.

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

## Install the agent on a Windows laptop

1. In the console, as an Admin, open **Admin → Set up and demo**. Step 2 there downloads the three things the laptop needs: the agent zip (`CabinetAgent-win-x64.zip`), a one-time install token (`token.txt`) and the platform CA certificate (`platform-ca.pem`). It also shows the exact PowerShell commands, with this server's address filled in, for the PowerShell that is on the laptop: Windows PowerShell 5.1 (on every Windows machine) or PowerShell 7. Its **What PowerShell version am I on?** button gives the operator the two steps to look, and reads back the number they see.
2. Follow `README.txt` inside the zip. Both engines install the same agent, so in short, in PowerShell as Administrator:
   ```powershell
   cd $HOME\Downloads\CabinetAgent
   Get-ChildItem -Recurse | Unblock-File
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\install\Install-CabinetAgent.ps1 -PlatformServerHost <domain or IP> -PlatformServerPort 8443 -PlatformCaFile .\platform-ca.pem -PlatformCaSha256 <the SHA-256 the console shows> -BootstrapTokenFile .\token.txt -AllowUnsigned
   ```
3. `-PlatformServerHost` must be one of the names in `AGENT_API_HOSTNAMES` in `deploy/.env`.
4. In the console, approve the enrollment request. The laptop comes online within a minute.

If the console has no download yet, get the same three files on the VPS:

```sh
cd deploy
docker compose cp server:/opt/cabinet/agent-download/CabinetAgent-win-x64.zip .
docker compose exec -T server cat /var/lib/cabinet/pki/dev-issuing-ca.cert.pem > platform-ca.pem
docker compose exec -T server node /opt/cabinet/server/dist/src/cli.js token create --as <admin username>
```

Save the token line in `token.txt`. Copy the three files to the laptop (for example with `scp`).

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

`setup.sh` installs a nightly job (`/etc/cron.d/cabinet-backup`, 02:17) that runs `deploy/backup.sh`:

- `BACKUP DATABASE` inside the SQL Server container (compressed, with checksums), then `RESTORE VERIFYONLY`;
- the backup is encrypted with the key in `/root/.cabinet-backup-key` (AES-256) and every plain copy is deleted;
- the last 14 are kept in `/var/backups/cabinet`; set `BACKUP_TARGET` (an rsync destination on another machine) in the cron line to copy each one off the server.

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

## Security notes

- **Demo CA only.** The server issues agent certificates with a development CA, whose private key lives in the `pki` volume on the VPS. Production uses a CA key held in a KMS, and a real TLS certificate for the agent API (`AGENT_TLS_CERT_FILE`, `AGENT_TLS_KEY_FILE`). The server refuses the development CA when `NODE_ENV=production`, so this image does not set it.
- **Ports.** Only 80, 443 and 8443 are published. Never publish Microsoft SQL Server (1433). It sits on an internal Docker network with no route out.
- **The console** is meant to sit on an internal network or VPN. Set `CONSOLE_ALLOW_FROM` in `.env` to your office and VPN ranges (CIDR, space-separated) and run `docker compose up -d`: everyone else gets 403. The default allows everyone, for a first demo only. HTTPS is enforced with HSTS on a domain.
- **Secrets** are only in `deploy/.env` (mode 600). It is ignored by git. Never commit or share it.
- **Docker and ufw.** Ports Docker publishes bypass `ufw`. Control access with your provider's firewall.
- **The agent zip** is an unsigned developer build. Never install it on a production cabinet.
- The server runs as a non-root user with a read-only file system. The database login it uses (`cabinet_app_login`) holds only the `cabinet_app` role.

# Live setup: real Agent on a Windows PC (e.g. the HP lab laptop)

This connects the real Windows Agent to a real Cabinet Server so the web Console shows that machine's actual health, services, processes and Windows event logs. For sample data, use **Settings → Data source → Demo** in the Console instead; demo data never touches this Server.

```text
 Windows PC (HP)                 Linux server host (on your tailnet)
 ───────────────                 ───────────────────────────────────────────────
 CabinetPlatformAgent service ──HTTPS──▶ :8446 Tailscale Serve ─▶ Cabinet Server 127.0.0.1:5019 ─▶ SQLite
                                                                      ▲
 Your browser ─────────────────HTTPS──▶ :8447 Tailscale Serve ─▶ Web Console 127.0.0.1:4190
```

The Agent only makes outbound HTTPS calls and only runs the compiled-in read-only diagnostics. Both ports are tailnet-only (the launcher refuses to run if Funnel exposes them publicly).

## What you need

- A Linux host for the Server, with the .NET 8 SDK, Node.js 20+ and Tailscale signed in (your VPS or build machine works).
- The Windows PC signed in to the **same tailnet**, with an administrator account.
- This repository checked out on the Linux host (`web-console` branch or later).

## 1. Start the Server and Console (Linux host)

```text
tools/live/start-web-console-live.sh --tailscale
```

It prints:

- **Console**, e.g. `https://myhost.tailXXXX.ts.net:8447`. Open it in your browser.
- **Agent server URL**, e.g. `https://myhost.tailXXXX.ts.net:8446`. The Windows installer needs it.
- A one-time **admin password**. Sign in as `admin`; you set your own password straight away.
- Where the **agent key** is: `AGENT_KEY` in `~/.cabinet-console-live/secrets.env` (mode 600). You type it into the installer. Don't paste it into chat or email.

If `tailscale serve` says it needs root, run `sudo tailscale set --operator=$USER` once.

Everything lives in `~/.cabinet-console-live`, separate from the demo stack and from any other Server deployment on that host. Ctrl+C stops it; data persists. To keep it running after you log out, run it in `tmux`/`screen` or a systemd user service (see the end of this page).

## 2. Build the Agent package (Linux host)

```text
tools/live/build-agent-package.sh
```

This writes `~/cabinet-agent-package/` containing `cabinet-agent.zip` (self-contained, so no .NET install is needed on Windows), `Install-CabinetAgent.ps1`, `Uninstall-CabinetAgent.ps1` and `SHA256SUMS`, and prints the exact install command including the zip's digest. The package contains no secrets.

Copy the folder to the PC, for example with `tailscale file cp ~/cabinet-agent-package/* <hp-machine-name>:` followed by `tailscale file get` on Windows, or a USB stick.

## 3. Install on the Windows PC

1. In a browser on the PC, open the **Agent server URL** with `/health` appended (e.g. `https://myhost.tailXXXX.ts.net:8446/health`). It should show `"status":"Healthy"`. If it doesn't, fix Tailscale connectivity before going further.
2. Open **PowerShell as administrator**, `cd` to the copied folder, and run the command the build script printed:

   ```powershell
   Unblock-File .\Install-CabinetAgent.ps1, .\Uninstall-CabinetAgent.ps1
   powershell -ExecutionPolicy Bypass -File .\Install-CabinetAgent.ps1 `
     -ServerUrl https://myhost.tailXXXX.ts.net:8446 -ExpectedSha256 <digest from SHA256SUMS>
   ```

   `-ExecutionPolicy Bypass` applies to this one PowerShell process only. Only use it with the script you just built and checked.

3. Paste the agent key at the hidden prompt.

The installer:

- checks the package digest, the Server's health over HTTPS and the agent key, before it changes anything;
- **refuses** if a `CabinetPlatformAgent` service or `C:\Program Files\Mashura\CabinetAgent` already exists, so an earlier Agent identity (such as the older Office-enrolled HP install) is never overwritten;
- installs to `C:\Program Files\Mashura\CabinetAgent`, readable only by SYSTEM and Administrators;
- creates an automatic `LocalSystem` service with restart-on-failure;
- stores the key only in that service's own environment (not a file, not the command line, not machine-wide);
- starts the service and prints the machine ID and the latest log lines.

The default check-in is every 60 seconds (`-CheckInSeconds` to change it, minimum 30), so diagnostics you request come back within about a minute.

## 4. Approve the PC in the Console

1. Sign in to the Console as an administrator, then go to **Administration → Enrollment**. The PC appears within a minute, listed by its computer name.
2. Check that the **machine ID** matches what the installer printed, then **Approve…** and give it a client, site and role (e.g. "Lab / Office / Standalone").
3. Within a minute it shows under **Cabinets** with its first full inventory: OS, services, installed software, disks, network and Windows Update.

## 5. Use it

Open the cabinet and use the tabs. Overview, Performance, Services, Storage, Network, Updates and System come from the Agent's regular check-ins. Click **Run diagnostic** to see:

- **Run an event log view.** Real Application/System events from the PC that match a saved view (e.g. "CUBEX application errors"; administrators can tailor views). Results appear on the **Events** tab.
- **View process list.** The PC's actual processes with CPU and memory, on the **Processes** tab.
- Firewall, display and scheduled-update reads are also available.

Support staff accounts you create under **Staff accounts** see all of this too.

## Removing or reinstalling

```powershell
.\Uninstall-CabinetAgent.ps1               # stop and delete the service, keep the folder
.\Uninstall-CabinetAgent.ps1 -RemoveFiles  # also delete the folder (needed before a reinstall)
```

The machine ID comes from the PC's hardware UUID, so a reinstall on the same PC is recognised as the same cabinet with its history. To stop it reporting for good, **Retire** it in the Console as well.

## Troubleshooting

| Symptom | Check |
|---|---|
| Installer: "Cannot reach …/health" | PC on the tailnet? `tailscale status` on both machines. Is the launcher running? |
| Installer: "rejected the agent key" | Copy `AGENT_KEY` again from `~/.cabinet-console-live/secrets.env`. |
| Service runs but nothing in Enrollment | `C:\Program Files\Mashura\CabinetAgent\logs\agent-*.log` on the PC; `~/.cabinet-console-live/server.log` on the host. |
| Approved but no data | Wait one check-in (60 s). Check the Agent log for HTTP errors. |
| Diagnostic stays "Dispatched" | The Agent picks it up on its next check-in. If the PC is asleep or offline it expires after 30 minutes. |

## Keeping the Server running (optional)

A systemd user unit on the Linux host:

```ini
# ~/.config/systemd/user/cabinet-console-live.service
[Unit]
Description=Cabinet Support live Server and Console
After=network-online.target

[Service]
ExecStart=%h/Cabinet_support_tool/tools/live/start-web-console-live.sh --tailscale --no-build
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now cabinet-console-live`, and `loginctl enable-linger $USER` so it survives logout.

## Security notes

- **Agent authentication.** The Agent uses this deployment's randomly generated shared agent key over HTTPS. That suits one machine or a small lab. For a real fleet, use per-device Office enrollment ([independent demo kit](independent-demo-kit.md)), where each device gets a unique credential. To rotate the key: stop the launcher, change `AGENT_KEY` in `secrets.env`, restart, and reinstall Agents with the new key.
- **Exposure.** Everything is reachable only on your tailnet. The Console holds no bearer tokens in the browser (see [web Console security](web-console.md#security-model)).
- **Not yet in place.** No MFA on staff sign-in yet (Entra integration is a release gate). Use it with your own lab machines, not customer cabinets, until the [release gates](readiness.md) are met.
- **Disabling Demo mode.** Set `CONSOLE_DEMO=disabled` for the Console process to remove the Demo option entirely.

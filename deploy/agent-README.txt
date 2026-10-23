Mashura Cabinet Agent - demo build for Windows 10/11 (x64)

This is a developer build for a test machine. It is not signed. Never install it on a production cabinet.

You need from the platform console (Admin):
  - platform-ca.pem   the platform's certificate authority (development CA)
  - token.txt         a one-time bootstrap token (valid 7 days, works once)
  - the server's public name or IP address, and port 8443

Install:
  1. Unzip this folder into your own Downloads folder (it makes Downloads\CabinetAgent). Not directly under C:\ : other users could change files there, and the installer refuses such a folder.
     The folder must contain "install" and "out" side by side.
  2. Put platform-ca.pem and token.txt in Downloads\CabinetAgent.
  3. Open PowerShell as Administrator. Windows PowerShell (the one every Windows machine has) and PowerShell 7 both work.
     Not sure which you have? In that window, type:   $PSVersionTable.PSVersion
     A number starting 5.1 is Windows PowerShell; a number starting 7 is PowerShell 7. Either way step 4 is the same.
  4. Run:
       cd $HOME\Downloads\CabinetAgent
       Get-ChildItem -Recurse | Unblock-File
       Set-ExecutionPolicy -Scope Process Bypass -Force
       .\install\Install-CabinetAgent.ps1 -PlatformServerHost <server name or IP> -PlatformServerPort 8443 -PlatformCaFile .\platform-ca.pem -PlatformCaSha256 <the SHA-256 the console shows> -BootstrapTokenFile .\token.txt -AllowUnsigned
     From another window, the same install works as:
       powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install\Install-CabinetAgent.ps1 <the same options>
     (use pwsh.exe instead of powershell.exe if you have PowerShell 7). The last lines say which PowerShell it ran in.
  5. In the console, approve the enrollment request (Administration).
     The agent picks up its certificate within a minute.

The server name or IP must be exactly the one the server's certificate was made for (AGENT_API_HOSTNAMES on the server).

Logs: C:\ProgramData\Mashura\CabinetAgent\logs

Remove:
  .\install\Uninstall-CabinetAgent.ps1 -RemoveData

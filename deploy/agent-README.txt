Mashura Cabinet Agent - demo build for Windows 10/11 (x64)

This is a developer build for a test machine. It is not signed. Never install it on a production cabinet.

You need from the platform console (Admin):
  - platform-ca.pem   the platform's certificate authority (development CA)
  - token.txt         a one-time bootstrap token (valid 7 days, works once)
  - the server's public name or IP address, and port 8443

Install:
  1. Unzip this folder, for example to C:\CabinetAgent.
     The folder must contain "install" and "out" side by side.
  2. Put platform-ca.pem and token.txt in C:\CabinetAgent.
  3. Open PowerShell as Administrator.
  4. Run:
       cd C:\CabinetAgent
       Get-ChildItem -Recurse | Unblock-File
       Set-ExecutionPolicy -Scope Process Bypass -Force
       .\install\Install-CabinetAgent.ps1 -PlatformServerHost <server name or IP> -PlatformServerPort 8443 -PlatformCaFile .\platform-ca.pem -BootstrapTokenFile .\token.txt
  5. In the console, approve the enrollment request (Administration).
     The agent picks up its certificate within a minute.

The server name or IP must be exactly the one the server's certificate was made for (AGENT_API_HOSTNAMES on the server).

Logs: C:\ProgramData\Mashura\CabinetAgent\logs

Remove:
  .\install\Uninstall-CabinetAgent.ps1 -RemoveData

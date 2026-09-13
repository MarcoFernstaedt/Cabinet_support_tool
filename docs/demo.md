# Isolated Windows demo setup

This procedure is for a disposable Windows 10 or Windows 11 x64 lab machine. It runs all components locally to test their behavior. The intended deployment still places the server on Mashura infrastructure. Do not point this setup at customer cabinets or existing company databases.

The walkthrough requires an official .NET 8 SDK for the local HTTPS development certificate and either the source checkout or a published package. Windows execution of these steps remains a manual acceptance gate. Do not disable certificate validation if a connection fails.

## Build from source

In PowerShell, from the repository root:

```powershell
dotnet publish src/CabinetPlatform.Server/CabinetPlatform.Server.csproj -c Release -r win-x64 --self-contained true -o publish/server
dotnet publish src/CabinetPlatform.Agent/CabinetPlatform.Agent.csproj -c Release -r win-x64 --self-contained true -o publish/agent
dotnet publish src/CabinetPlatform.Console/CabinetPlatform.Console.csproj -c Release -r win-x64 --self-contained true -o publish/console
```

The executables include their runtimes. Use a fresh copy of these folders for each independent lab run. Do not reuse a database while generating unrelated new signing keys or seed passwords.

## Prepare the local certificate

Run this only inside the disposable lab. Windows will ask to trust a development certificate for this user.

```powershell
dotnet dev-certs https --trust
```

All three processes below must run as the same Windows user so they see the same user certificate trust. For access to protected local diagnostics, use an elevated PowerShell session under that same account. This procedure does not install a persistent Windows service.

## Start the local server

Stay in the same PowerShell session for the following steps. Secrets are generated or entered locally and passed through process environment variables. Do not paste their values into chat or commit them.

```powershell
$root = (Resolve-Path publish).Path
$serverDir = Join-Path $root 'server'
$agentDir = Join-Path $root 'agent'
$consoleDir = Join-Path $root 'console'
$api = 'https://localhost:7030'

function New-LabSecret {
    $bytes = New-Object byte[] 48
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [Convert]::ToBase64String($bytes)
}

$agentKey = New-LabSecret
$seedPassword = Read-Host 'Choose a new lab supervisor password of at least 12 characters with mixed character classes' -AsSecureString
$env:Jwt__SigningKey = New-LabSecret
$env:AgentAuth__SharedSecret = $agentKey
$env:Seed__SupervisorUsername = 'lab-supervisor'
$env:Seed__SupervisorInitialPassword = ([Net.NetworkCredential]::new('', $seedPassword)).Password
$env:ASPNETCORE_URLS = $api
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$env:ConnectionStrings__SupportDatabase = 'Data Source=lab-support.db'
$env:Actions__ExecutionMode = 'DiagnosticOnly'
$env:AgentIngest__CheckInIntervalSeconds = '15'
$env:AgentIngest__RegistrationRetrySeconds = '15'

$server = Start-Process (Join-Path $serverDir 'CabinetPlatform.Server.exe') -WorkingDirectory $serverDir -PassThru

# The server inherited its own environment. Do not give its secrets to the agent or console.
Remove-Item Env:Jwt__SigningKey, Env:AgentAuth__SharedSecret, Env:Seed__SupervisorInitialPassword
$seedPassword = $null
```

Wait for the server to report that it is listening on the configured HTTPS address. Stop if startup or certificate validation fails. The development certificate is for this local lab only, not Mashura deployment.

## Start the agent and console

```powershell
$env:CABINET_AGENT_KEY = $agentKey
$env:Agent__ServerBaseUrl = $api
$env:Agent__CheckInIntervalSeconds = '15'
$env:Agent__Actions__ExecutionMode = 'DiagnosticOnly'
$agent = Start-Process (Join-Path $agentDir 'CabinetPlatform.Agent.exe') -WorkingDirectory $agentDir -PassThru
Remove-Item Env:CABINET_AGENT_KEY
$agentKey = $null

$env:MASHURA_CONSOLE_Api__BaseAddress = "$api/"
$console = Start-Process (Join-Path $consoleDir 'CabinetPlatform.Console.exe') -WorkingDirectory $consoleDir -PassThru
```

Sign in to the console as `lab-supervisor` with the password chosen above. Complete the mandatory password change, then sign in again with the new password. The current registration administration is an API workflow; it is not yet a completed console administration screen.

## Approve only the lab machine

In the same PowerShell session, authenticate using the new password. The server issues temporary tokens; do not print or share the login object or request headers.

```powershell
$password = Read-Host 'Current lab supervisor password' -AsSecureString
$loginBody = @{
    username = 'lab-supervisor'
    password = ([Net.NetworkCredential]::new('', $password)).Password
} | ConvertTo-Json
$login = Invoke-RestMethod "$api/api/auth/login" -Method Post -ContentType 'application/json' -Body $loginBody
$headers = @{ Authorization = "Bearer $($login.accessToken)" }
$password = $null
$loginBody = $null

$pending = Invoke-RestMethod "$api/api/registrations/pending" -Headers $headers
$pending.items | Select-Object id, hostname, machineId
$id = Read-Host 'Exact registration id of this disposable lab machine'
$selected = @($pending.items | Where-Object { $_.id -eq $id })
if ($selected.Count -ne 1) { throw 'Registration was not uniquely selected; nothing was approved.' }
$confirmation = Read-Host "Approve only lab host $($selected[0].hostname)? Type APPROVE"
if ($confirmation -ne 'APPROVE') { throw 'Approval cancelled.' }
$approval = @{
    clientName = 'Synthetic Demo Client'
    siteName = 'Disposable Windows Lab'
    departmentName = 'Support Testing'
    role = 'Standalone'
    ticketReference = 'LAB-DEMO'
} | ConvertTo-Json
Invoke-RestMethod "$api/api/registrations/$id/approve" -Method Post -Headers $headers -ContentType 'application/json' -Body $approval
$headers = $null
$login = $null
```

Wait for the agent to learn approval and send a check in. Refresh the console, find the synthetic client and open the lab cabinet. Initial collection can take time, particularly while Windows Update APIs respond.

## Walk through the diagnostics

Follow [Windows demo checks](testing.md). Request a process list and run a seeded named event view. Use action history and refresh to follow each request to its result. Expect snapshots, not a continuous Task Manager stream. The current history recovery examines the latest 100 requests.

Diagnostic mode permits `GetProcessList`, `CollectEventLogs`, `RunEventLogView` and `GetScheduledUpdates`. The structured event grid uses named event views. Process termination, service changes, updates, network changes and display rotation are not part of this diagnostic acceptance. Do not switch to `Maintenance` to bypass an unfinished safety review.

## Stop and preserve evidence

Close the console and stop the foreground agent and server cleanly with Ctrl+C in their process windows. Do not remove the database or state while a process is running. Save sanitized logs and the tested commit identifier if a check fails, then restore the VM snapshot.

This build still uses a shared agent credential. Separate device credentials and production credential lifecycle remain release blockers. The demo's generated secrets, local HTTPS and diagnostic mode do not turn it into a production deployment.

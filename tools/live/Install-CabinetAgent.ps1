<#
.SYNOPSIS
  Installs the Mashura Cabinet Support Agent as a Windows service.

.DESCRIPTION
  Fresh install only. Refuses to touch an existing CabinetPlatformAgent service
  or install folder, so an earlier Agent identity and its state are never
  overwritten.

  The Agent runs as LocalSystem, makes outbound HTTPS calls only, and performs
  only the compiled-in observation diagnostics (process list, event log views,
  firewall/display/update reads). It registers with the Server and does
  nothing else until an administrator approves it in the web Console.

  The agent key is read with a hidden prompt and stored only in this service's
  own environment (registry: the service's "Environment" value), not in a file,
  not on the command line, not in the machine-wide environment.

.PARAMETER ServerUrl
  HTTPS origin of the Cabinet Server as reached from this machine, e.g.
  https://my-server.tailnet-name.ts.net:8446

.PARAMETER AgentZip
  Path to cabinet-agent.zip from build-agent-package.sh.

.PARAMETER ExpectedSha256
  SHA-256 of cabinet-agent.zip from SHA256SUMS. Strongly recommended.

.PARAMETER CheckInSeconds
  Heartbeat and diagnostics poll interval (30-86400). Default 60 so requested
  diagnostics return within about a minute.

.EXAMPLE
  .\Install-CabinetAgent.ps1 -ServerUrl https://srv.example.ts.net:8446 -ExpectedSha256 3f2a...
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerUrl,
    [string]$AgentZip = (Join-Path $PSScriptRoot 'cabinet-agent.zip'),
    [string]$ExpectedSha256,
    [ValidateRange(30, 86400)][int]$CheckInSeconds = 60
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ServiceName = 'CabinetPlatformAgent'
$Install = Join-Path $env:ProgramFiles 'Mashura\CabinetAgent'

function Fail([string]$Message) {
    Write-Host ''
    Write-Host "Install stopped: $Message" -ForegroundColor Red
    exit 1
}
function Step([string]$Message) { Write-Host "-> $Message" -ForegroundColor Cyan }

# --- Preconditions ---------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'Run this from an elevated PowerShell (Run as administrator).'
}
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'The Agent package is for 64-bit Windows.' }

$uri = $null
if (-not [Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or
    $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
    Fail 'ServerUrl must be a bare https:// address such as https://server.example.ts.net:8446'
}
$ServerUrl = $uri.GetLeftPart([UriPartial]::Authority)

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Fail "A '$ServiceName' service already exists. This installer never overwrites an existing Agent or its identity. Run Uninstall-CabinetAgent.ps1 first if you intend to replace it."
}
if (Test-Path -LiteralPath $Install) {
    Fail "$Install already exists. It may hold an earlier Agent identity. Move it aside or run Uninstall-CabinetAgent.ps1 -RemoveFiles if you are sure."
}
if (-not (Test-Path -LiteralPath $AgentZip -PathType Leaf)) { Fail "Agent package not found: $AgentZip" }

if ($ExpectedSha256) {
    Step 'Verifying package digest'
    $actual = (Get-FileHash -LiteralPath $AgentZip -Algorithm SHA256).Hash
    if ($actual -ne $ExpectedSha256.Trim().ToUpperInvariant()) { Fail "cabinet-agent.zip digest $actual does not match the expected value." }
} else {
    Write-Host 'Warning: no -ExpectedSha256 given; the package digest is not being checked.' -ForegroundColor Yellow
}

Step "Checking the Server at $ServerUrl"
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}
try {
    $health = Invoke-RestMethod -Uri "$ServerUrl/health" -UseBasicParsing -TimeoutSec 15
    if ($health.status -ne 'Healthy') { Fail "The Server answered but reports '$($health.status)'." }
} catch {
    Fail "Cannot reach $ServerUrl/health over HTTPS ($($_.Exception.Message)). Check the address, that this machine is on the same Tailscale network, and that the certificate is trusted."
}

# --- Agent key ---------------------------------------------------------------------
$secure = Read-Host -AsSecureString 'Agent key (AGENT_KEY from the server secrets file; input is hidden)'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $AgentKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ([string]::IsNullOrWhiteSpace($AgentKey) -or $AgentKey.Length -lt 20 -or $AgentKey -match '[\s\x00-\x1f]') {
    Fail 'That does not look like an agent key (expected at least 20 characters, no spaces).'
}

# Probe the key without registering: an unknown machine ID with a bad key is
# refused with 401; a good key reaches the registration endpoint.
Step 'Checking the agent key'
try {
    $probe = [Net.HttpWebRequest]::Create("$ServerUrl/api/agent/actions")
    $probe.Method = 'GET'
    $probe.Timeout = 15000
    $probe.Headers.Add('X-Mashura-Agent-Key', $AgentKey)
    $probe.Headers.Add('X-Mashura-Machine-Id', 'install-key-probe')
    $code = 0
    try { $code = [int]$probe.GetResponse().StatusCode } catch [Net.WebException] {
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } else { throw }
    }
    if ($code -eq 401) { Fail 'The Server rejected the agent key. Copy AGENT_KEY again from the server secrets file.' }
} catch { Fail "Key check failed: $($_.Exception.Message)" }

# --- Files -------------------------------------------------------------------------
Step "Installing to $Install"
$parent = Split-Path -Parent $Install
if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
New-Item -ItemType Directory -Path $Install | Out-Null
# Only SYSTEM and Administrators can read or change the Agent, its identity and its logs.
& icacls.exe $Install /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'Could not set permissions on the install folder.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $AgentZip))
try {
    $root = [IO.Path]::GetFullPath($Install + [IO.Path]::DirectorySeparatorChar)
    foreach ($entry in $archive.Entries) {
        $target = [IO.Path]::GetFullPath((Join-Path $Install $entry.FullName))
        if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { Fail "Unsafe path in package: $($entry.FullName)" }
        if ($entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $target | Out-Null; continue }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
} finally { $archive.Dispose() }
if (-not (Test-Path -LiteralPath (Join-Path $Install 'CabinetPlatform.Agent.exe'))) { Fail 'The package does not contain CabinetPlatform.Agent.exe.' }

# Absolute paths: a service's working directory is System32, not the install folder.
$base = $Install.Replace('\', '/')
$settings = [ordered]@{
    Agent = [ordered]@{
        ServerBaseUrl          = "$ServerUrl/"
        CheckInIntervalSeconds = $CheckInSeconds
        StateDirectory         = "$base/state"
        LogDirectory           = "$base/logs"
        Buffer                 = @{ Directory = "$base/buffer" }
        Actions                = @{ DiagnosticBundleDirectory = "$base/bundles" }
    }
    Serilog = @{ WriteTo = @{ '1' = @{ Args = @{ path = "$base/logs/agent-.log" } } } }
}
$json = $settings | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $Install 'appsettings.Production.json'), $json, (New-Object Text.UTF8Encoding($false)))

# --- Service -------------------------------------------------------------------------
Step 'Creating the Windows service'
$exe = Join-Path $Install 'CabinetPlatform.Agent.exe'
& sc.exe create $ServiceName binPath= "`"$exe`"" DisplayName= 'Mashura Cabinet Support Agent' start= auto obj= LocalSystem | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'sc.exe create failed.' }
& sc.exe description $ServiceName 'Reports cabinet health to Mashura support and runs read-only diagnostics on request.' | Out-Null
& sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/120000/restart/300000 | Out-Null
& sc.exe failureflag $ServiceName 1 | Out-Null

# Service-scoped environment: only this service's process receives the key.
$serviceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
New-ItemProperty -Path $serviceKey -Name 'Environment' -PropertyType MultiString -Value @("CABINET_AGENT_KEY=$AgentKey", 'DOTNET_ENVIRONMENT=Production') -Force | Out-Null
Remove-Variable AgentKey

Step 'Starting the service'
Start-Service -Name $ServiceName
$deadline = (Get-Date).AddSeconds(30)
do { Start-Sleep -Seconds 1; $svc = Get-Service -Name $ServiceName } while ($svc.Status -ne 'Running' -and (Get-Date) -lt $deadline)
if ($svc.Status -ne 'Running') { Fail "The service did not start. Check Event Viewer > Windows Logs > Application and $Install\logs." }

# Give the first registration a moment, then show what the Agent logged.
Start-Sleep -Seconds 8
$log = Get-ChildItem -LiteralPath (Join-Path $Install 'logs') -Filter 'agent-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$machineId = $null
$stateFile = Get-ChildItem -LiteralPath (Join-Path $Install 'state') -Filter 'agent-state.json' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($stateFile) { try { $machineId = (Get-Content -Raw -LiteralPath $stateFile.FullName | ConvertFrom-Json).machineId } catch { } }

Write-Host ''
Write-Host 'Agent installed and running.' -ForegroundColor Green
Write-Host "  Computer:   $env:COMPUTERNAME"
if ($machineId) { Write-Host "  Machine ID: $machineId   (check it matches in the Console before approving)" }
Write-Host "  Server:     $ServerUrl"
Write-Host "  Logs:       $Install\logs"
if ($log) {
    Write-Host ''
    Write-Host 'Latest Agent log lines:'
    Get-Content -LiteralPath $log.FullName -Tail 8 | ForEach-Object { Write-Host "  $_" }
}
Write-Host ''
Write-Host 'Next: in the web Console go to Administration > Enrollment, verify the machine ID and approve this computer.'

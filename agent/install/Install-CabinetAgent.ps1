<#
.SYNOPSIS
  Installs the cabinet agent's two services on this machine (milestone 1: no server connection yet).
.DESCRIPTION
  - CabinetAgentBroker runs as LocalSystem and never opens a network connection.
  - CabinetAgentNetwork runs as its own virtual account (NT SERVICE\CabinetAgentNetwork),
    with no administrator rights and only the privileges it needs.
  - The local configuration is written to C:\ProgramData\Mashura\CabinetAgent, which only
    SYSTEM and Administrators can change. The network service can read it, and can write only
    its own state and log folders.
  Run from an elevated PowerShell, after Publish-CabinetAgent.ps1.
.EXAMPLE
  .\Install-CabinetAgent.ps1 -EnableLocalHarness
.EXAMPLE
  .\Install-CabinetAgent.ps1 -PlatformServerHost diag.mashura.example -PlatformServerPort 8443 -PlatformCaFile .\platform-ca.pem -BootstrapTokenFile .\bootstrap-token.txt
  Connects to the platform server. The token comes from platform-admin token create; it works once and is deleted after use.
.EXAMPLE
  .\Install-CabinetAgent.ps1 -ScannerHardwareId 'USB\VID_1234&PID_5678' -SyncCabinetAddress 10.20.0.15 -AllowedTcpPort 1433 -ReadOnly
#>
[CmdletBinding()]
param(
    [string] $SourceDir = (Join-Path $PSScriptRoot '..\out'),
    [guid] $CabinetId = [guid]::NewGuid(),
    [switch] $ReadOnly,
    [ValidateSet('sync', 'satellite', 'standalone')] [string] $CabinetRole,
    [string[]] $ScannerHardwareId = @(),
    [string] $SyncCabinetAddress,
    [string] $PlatformServerHost,
    [ValidateRange(1, 65535)] [int] $PlatformServerPort,
    [string] $PlatformCaFile,
    [ValidatePattern('^[A-Za-z0-9_-]{32,128}$')] [string] $BootstrapToken,
    # Preferred over -BootstrapToken: a token on the command line can be kept by process-creation auditing and script-block logging.
    [string] $BootstrapTokenFile,
    [ValidateRange(1, 65535)] [int[]] $AllowedTcpPort = @(),
    [switch] $EnableLocalHarness
)
$ErrorActionPreference = 'Stop'
if ($BootstrapTokenFile) {
    if ($BootstrapToken) { throw 'Give -BootstrapToken or -BootstrapTokenFile, not both.' }
    $BootstrapToken = (Get-Content -LiteralPath $BootstrapTokenFile -Raw).Trim()
    if ($BootstrapToken -notmatch '^[A-Za-z0-9_-]{32,128}$') { throw 'The bootstrap token file does not hold a bootstrap token.' }
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from an elevated PowerShell.' }

$broker = 'CabinetAgentBroker'
$network = 'CabinetAgentNetwork'
$networkAccount = "NT SERVICE\$network"
$programDir = Join-Path $env:ProgramFiles 'Mashura\CabinetAgent'
$dataDir = Join-Path $env:ProgramData 'Mashura\CabinetAgent'
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'

function Invoke-Sc([string[]] $Arguments) {
    & $sc @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe $($Arguments[0]) failed with $LASTEXITCODE." }
}

# 1. Program files (inherit the Program Files ACL: only administrators can change them).
foreach ($service in @{ Name = $broker; Project = 'Cabinet.Agent.Broker' }, @{ Name = $network; Project = 'Cabinet.Agent.Network' }, @{ Name = 'harness'; Project = 'Cabinet.Agent.Harness' }, @{ Name = 'updater'; Project = 'Cabinet.Agent.Updater' }) {
    $from = Join-Path $SourceDir $service.Project
    if (-not (Test-Path $from)) { throw "Missing $from. Run Publish-CabinetAgent.ps1 first." }
    $to = Join-Path $programDir $service.Project
    if (Get-Service -Name $service.Name -ErrorAction SilentlyContinue) { Stop-Service -Name $service.Name -Force }
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    Copy-Item -Path (Join-Path $from '*') -Destination $to -Recurse -Force
}

# 2. Services. The network service depends on the broker and runs as its virtual account.
$brokerExe = Join-Path $programDir 'Cabinet.Agent.Broker\Cabinet.Agent.Broker.exe'
$networkExe = Join-Path $programDir 'Cabinet.Agent.Network\Cabinet.Agent.Network.exe'
if (-not (Get-Service -Name $broker -ErrorAction SilentlyContinue)) {
    New-Service -Name $broker -BinaryPathName "`"$brokerExe`"" -DisplayName 'Mashura Cabinet Agent Broker' -StartupType Automatic `
        -Description 'Performs the cabinet agent''s privileged reads. Accepts requests only from the agent network service over a local pipe.' | Out-Null
}
if (-not (Get-Service -Name $network -ErrorAction SilentlyContinue)) {
    New-Service -Name $network -BinaryPathName "`"$networkExe`"" -DisplayName 'Mashura Cabinet Agent' -StartupType Automatic -DependsOn $broker `
        -Description 'Cabinet diagnostics agent. Runs without administrator rights.' | Out-Null
}
Invoke-Sc @('config', $network, 'obj=', $networkAccount)
Invoke-Sc @('sidtype', $network, 'unrestricted')
# Only the privilege every process needs; everything else is removed from the network service's token.
Invoke-Sc @('privs', $network, 'SeChangeNotifyPrivilege')
foreach ($name in $broker, $network) { Invoke-Sc @('failure', $name, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/300000') }

# The cabinet's private key: generated here, on the cabinet, in the machine key store, non-exportable.
# Only the network service (and SYSTEM and administrators) may use it; the service cannot create machine keys itself.
& (Join-Path $programDir 'Cabinet.Agent.Harness\cabinet-harness.exe') provision-key
if ($LASTEXITCODE -ne 0) { throw 'Creating the cabinet key failed.' }

# 3. Data folder: SYSTEM and Administrators own it; the network service gets only what it needs.
function New-Rule([string] $Account, [string] $Rights, [bool] $Inherit = $true) {
    $flags = if ($Inherit) { 'ContainerInherit,ObjectInherit' } else { 'None' }
    New-Object Security.AccessControl.FileSystemAccessRule($Account, $Rights, $flags, 'None', 'Allow')
}
function Set-FolderAcl([string] $Path, [object[]] $Rules) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    $acl.AddAccessRule((New-Rule 'NT AUTHORITY\SYSTEM' 'FullControl'))
    $acl.AddAccessRule((New-Rule 'BUILTIN\Administrators' 'FullControl'))
    foreach ($rule in $Rules) { $acl.AddAccessRule($rule) }
    Set-Acl -Path $Path -AclObject $acl
}
# ProgramData lets any user create folders, so a folder made before the install could be owned by someone else, who could
# then swap its contents. Refuse a Mashura folder that is a link or not owned by SYSTEM or Administrators, then lock it down.
$mashuraDir = Split-Path $dataDir -Parent
foreach ($dir in @($mashuraDir, $dataDir)) {
    $item = Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
    if ($item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$dir is a link, not a folder. Remove it and install again." }
        $owner = (Get-Acl -LiteralPath $dir).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin @('S-1-5-18', 'S-1-5-32-544')) { throw "$dir is owned by $owner, not SYSTEM or Administrators. Remove it and install again." }
    }
}
Set-FolderAcl $mashuraDir @()
Set-FolderAcl $dataDir @((New-Rule $networkAccount 'ReadAndExecute' $false))
Set-FolderAcl (Join-Path $dataDir 'state') @((New-Rule $networkAccount 'Modify'))
Set-FolderAcl (Join-Path $dataDir 'logs') @((New-Rule $networkAccount 'Modify'))
Set-FolderAcl (Join-Path $dataDir 'harness') @((New-Rule $networkAccount 'ReadAndExecute' $false))
Set-FolderAcl (Join-Path $dataDir 'harness\inbox') @((New-Rule $networkAccount 'Modify'))
Set-FolderAcl (Join-Path $dataDir 'harness\outbox') @((New-Rule $networkAccount 'Modify'))

# 4. Local configuration. The agent validates it against agent-config.schema.json and refuses to start if it does not match.
$configPath = Join-Path $dataDir 'agent-config.json'
$config = [ordered]@{
    cabinetId       = $CabinetId.ToString()
    readOnlyMode    = [bool]$ReadOnly
    cabinetRole     = if ($CabinetRole) { $CabinetRole } else { $null }
    scanner         = [ordered]@{ hardwareIds = @($ScannerHardwareId) }
    syncCabinet     = [ordered]@{ address = if ($SyncCabinetAddress) { $SyncCabinetAddress } else { $null } }
    platformServer  = [ordered]@{
        host = if ($PlatformServerHost) { $PlatformServerHost } else { $null }
        port = if ($PlatformServerPort) { $PlatformServerPort } else { $null }
    }
    allowedTcpPorts = @($AllowedTcpPort)
    localHarness    = [bool]$EnableLocalHarness
}
$json = ConvertTo-Json -InputObject $config -Depth 4
[IO.File]::WriteAllText($configPath, $json, (New-Object Text.UTF8Encoding($false)))
$fileAcl = New-Object Security.AccessControl.FileSecurity
$fileAcl.SetAccessRuleProtection($true, $false)
$fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\SYSTEM', 'FullControl', 'Allow')))
$fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('BUILTIN\Administrators', 'FullControl', 'Allow')))
$fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($networkAccount, 'Read', 'Allow')))
Set-Acl -Path $configPath -AclObject $fileAcl

# 5. Platform server trust and the one-time bootstrap token.
if ($PlatformCaFile) {
    $caPath = Join-Path $dataDir 'platform-ca.pem'
    Copy-Item -Path $PlatformCaFile -Destination $caPath -Force
    Set-Acl -Path $caPath -AclObject $fileAcl   # administrators change it; the network service only reads it
}
if ($BootstrapToken) {
    # The state folder admits only SYSTEM, administrators and the network service, which deletes the token once the server accepts it.
    [IO.File]::WriteAllText((Join-Path $dataDir 'state\bootstrap-token'), $BootstrapToken, (New-Object Text.UTF8Encoding($false)))
}

# 6. Start.
Start-Service -Name $broker
Start-Service -Name $network
Get-Service -Name $broker, $network | Format-Table -AutoSize Name, Status, StartType
Write-Host "Cabinet ID: $CabinetId"
Write-Host "Configuration: $configPath"
Write-Host "Logs: $(Join-Path $dataDir 'logs')"
if ($EnableLocalHarness) { Write-Host "Local harness inbox: $(Join-Path $dataDir 'harness\inbox')" }

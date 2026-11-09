<#
.SYNOPSIS
  Checks that the cabinet agent is installed the way Install-CabinetAgent.ps1 installs it, on this machine. Read only.
.DESCRIPTION
  Run it as SYSTEM from a remote management tool, or from an elevated Windows PowerShell 5.1. It changes nothing on the
  machine: it reads the two services, the program and data folders and their permissions, the configuration, and whether
  the platform server answers on its port. It never prints the configuration's values beyond the server address, and never
  reads a token or a key.

  Each check prints one line: PASS, WARN or FAIL, its name, and what was found. A JSON file with the same results is written
  to C:\ProgramData\Mashura\CabinetAgent-Acceptance\ for sending to support. Exit code 0: no check failed. Exit code 1: at
  least one did.

  The second half of acceptance runs from the console: open the cabinet, then Overview, "Test <cabinet>". It runs the
  read-only checks against this machine through the platform and gives a report to copy.
.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Test-CabinetAgent.ps1
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$brokerName = 'CabinetAgentBroker'
$networkName = 'CabinetAgentNetwork'
$networkAccount = "NT SERVICE\$networkName"
$programDir = Join-Path $env:ProgramFiles 'Mashura\CabinetAgent'
$dataDir = Join-Path $env:ProgramData 'Mashura\CabinetAgent'
$systemSid = 'S-1-5-18'
$adminsSid = 'S-1-5-32-544'

$results = New-Object System.Collections.Generic.List[object]
function Add-Result([string] $Status, [string] $Name, [string] $Detail) {
    $results.Add([ordered]@{ status = $Status; check = $Name; detail = $Detail })
    $label = $Status.PadRight(5)
    $colour = switch ($Status) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
    Write-Host ($label + ' ' + $Name + ': ' + $Detail) -ForegroundColor $colour
}
# Runs one check; an unexpected error is that check's FAIL, never the end of the run.
function Invoke-Check([string] $Name, [scriptblock] $Body) {
    try { & $Body } catch { Add-Result 'FAIL' $Name ('could not be checked: ' + $_.Exception.Message) }
}
function Get-Sid([string] $Account) {
    try { return (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { return $null }
}
# The accounts that may change agent files: SYSTEM, Administrators, and Windows' own installer and file-owner entries.
$trustedWriters = @($systemSid, $adminsSid, 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-0')
$writeRights = [Security.AccessControl.FileSystemRights]'Write, Modify, FullControl, TakeOwnership, ChangePermissions, Delete, CreateFiles, AppendData'
function Get-UntrustedWriters([string] $Path, [string[]] $AlsoAllowed) {
    $acl = Get-Acl -LiteralPath $Path
    $found = @()
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        if (($rule.FileSystemRights -band $writeRights) -eq 0) { continue }
        $sid = try { $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { [string]$rule.IdentityReference }
        if ($trustedWriters -contains $sid -or $AlsoAllowed -contains $sid) { continue }
        $found += [string]$rule.IdentityReference
    }
    return $found
}

Write-Host ('Cabinet agent acceptance check on ' + $env:COMPUTERNAME + ', ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss') + ' UTC')
Write-Host ''

Invoke-Check 'Administrator rights' {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Add-Result 'PASS' 'Administrator rights' 'running elevated' }
    else { Add-Result 'FAIL' 'Administrator rights' 'not elevated; the folder and service checks below need SYSTEM or an elevated PowerShell' }
}

Invoke-Check 'Windows' {
    $os = Get-CimInstance Win32_OperatingSystem
    $arch = if ([Environment]::Is64BitOperatingSystem) { '64-bit' } else { '32-bit' }
    Add-Result 'PASS' 'Windows' ($os.Caption + ', build ' + $os.BuildNumber + ', ' + $arch + ', PowerShell ' + $PSVersionTable.PSVersion.ToString())
}

foreach ($svc in @(@{ Name = $brokerName; Account = 'LocalSystem' }, @{ Name = $networkName; Account = $networkAccount })) {
    Invoke-Check ('Service ' + $svc.Name) {
        $s = Get-CimInstance Win32_Service -Filter ("Name = '" + $svc.Name + "'")
        if (-not $s) { Add-Result 'FAIL' ('Service ' + $svc.Name) 'not installed'; return }
        $problems = @()
        if ($s.State -ne 'Running') { $problems += ('state ' + $s.State) }
        if ($s.StartMode -ne 'Auto') { $problems += ('start mode ' + $s.StartMode) }
        if ($s.StartName -ne $svc.Account) { $problems += ('runs as ' + $s.StartName + ', expected ' + $svc.Account) }
        if ($problems.Count -gt 0) { Add-Result 'FAIL' ('Service ' + $svc.Name) ($problems -join '; ') }
        else { Add-Result 'PASS' ('Service ' + $svc.Name) ('running, automatic, as ' + $s.StartName) }
    }
}

Invoke-Check 'Network service is not an administrator' {
    $members = @()
    $group = [ADSI]('WinNT://./' + (New-Object Security.Principal.SecurityIdentifier($adminsSid)).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1] + ',group')
    foreach ($m in @($group.Invoke('Members'))) { $members += [string]$m.GetType().InvokeMember('Name', 'GetProperty', $null, $m, $null) }
    if ($members -contains $networkName) { Add-Result 'FAIL' 'Network service is not an administrator' ($networkAccount + ' is a member of the local Administrators group') }
    else { Add-Result 'PASS' 'Network service is not an administrator' ($networkAccount + ' is not in the local Administrators group') }
}

Invoke-Check 'Program signatures' {
    if (-not (Test-Path -LiteralPath $programDir -PathType Container)) { Add-Result 'FAIL' 'Program signatures' ($programDir + ' does not exist'); return }
    $programs = @(Get-ChildItem -LiteralPath $programDir -Recurse -File -Include '*.exe' -ErrorAction SilentlyContinue)
    $unsigned = @($programs | Where-Object { (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status -ne 'Valid' })
    if ($programs.Count -eq 0) { Add-Result 'FAIL' 'Program signatures' 'no programs found' }
    elseif ($unsigned.Count -eq 0) { Add-Result 'PASS' 'Program signatures' ([string]$programs.Count + ' programs, all validly signed') }
    else { Add-Result 'WARN' 'Program signatures' ([string]$unsigned.Count + ' of ' + [string]$programs.Count + ' programs are not validly signed (expected only for a development build), first: ' + $unsigned[0].Name) }
}

Invoke-Check 'Agent version' {
    $exe = Join-Path $programDir 'Cabinet.Agent.Network\Cabinet.Agent.Network.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { Add-Result 'FAIL' 'Agent version' ($exe + ' is missing'); return }
    $v = (Get-Item -LiteralPath $exe).VersionInfo
    Add-Result 'PASS' 'Agent version' ($v.ProductVersion)
}

Invoke-Check 'Program folder permissions' {
    if (-not (Test-Path -LiteralPath $programDir -PathType Container)) { Add-Result 'FAIL' 'Program folder permissions' ($programDir + ' does not exist'); return }
    # Every item, as the installer checks them: a loosened permission on one program inside a sound folder is still a way in.
    $items = @(Get-Item -LiteralPath $programDir -Force) + @(Get-ChildItem -LiteralPath $programDir -Recurse -Force -ErrorAction SilentlyContinue)
    $problems = @()
    foreach ($item in $items) {
        $owner = (Get-Acl -LiteralPath $item.FullName).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($trustedWriters -notcontains $owner) { $problems += ($item.FullName + ' is owned by ' + $owner) }
        $others = @(Get-UntrustedWriters $item.FullName @())
        if ($others.Count -gt 0) { $problems += ($item.FullName + ' can be changed by ' + (($others | Select-Object -Unique) -join ', ')) }
    }
    if ($problems.Count -eq 0) { Add-Result 'PASS' 'Program folder permissions' ('only SYSTEM and Administrators own or can change the folder and its ' + [string]($items.Count - 1) + ' files and folders') }
    else { Add-Result 'FAIL' 'Program folder permissions' ([string]$problems.Count + ' problems, first: ' + $problems[0]) }
}

Invoke-Check 'Data folder permissions' {
    if (-not (Test-Path -LiteralPath $dataDir -PathType Container)) { Add-Result 'FAIL' 'Data folder permissions' ($dataDir + ' does not exist'); return }
    $owner = (Get-Acl -LiteralPath $dataDir).GetOwner([Security.Principal.SecurityIdentifier]).Value
    $networkSid = Get-Sid $networkAccount
    $problems = @()
    if (@($systemSid, $adminsSid) -notcontains $owner) { $problems += ('owned by ' + $owner) }
    $top = @(Get-UntrustedWriters $dataDir @())
    if ($top.Count -gt 0) { $problems += ('the folder can be changed by: ' + (($top | Select-Object -Unique) -join ', ')) }
    foreach ($sub in 'state', 'logs') {
        $path = Join-Path $dataDir $sub
        if (Test-Path -LiteralPath $path -PathType Container) {
            $extra = @(Get-UntrustedWriters $path @($networkSid))
            if ($extra.Count -gt 0) { $problems += ($sub + ' can be changed by: ' + (($extra | Select-Object -Unique) -join ', ')) }
        } else { $problems += ($sub + ' is missing') }
    }
    if ($problems.Count -eq 0) { Add-Result 'PASS' 'Data folder permissions' 'owned by SYSTEM or Administrators; only the network service may also write its state and logs' }
    else { Add-Result 'FAIL' 'Data folder permissions' ($problems -join '; ') }
}

$serverHost = $null
$serverPort = $null
Invoke-Check 'Configuration' {
    $path = Join-Path $dataDir 'agent-config.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Add-Result 'FAIL' 'Configuration' ($path + ' is missing'); return }
    $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $script:serverHost = [string]$config.platformServer.host
    $script:serverPort = [int]$config.platformServer.port
    if (-not $script:serverHost -or $script:serverPort -le 0) { Add-Result 'FAIL' 'Configuration' 'no platform server address is set'; return }
    $mode = if ($config.readOnlyMode) { 'read-only mode on' } else { 'read-only mode off' }
    Add-Result 'PASS' 'Configuration' ('platform server ' + $script:serverHost + ':' + [string]$script:serverPort + ', ' + $mode)
}

Invoke-Check 'Platform CA' {
    $path = Join-Path $dataDir 'platform-ca.pem'
    if (Test-Path -LiteralPath $path -PathType Leaf) { Add-Result 'PASS' 'Platform CA' ('present, SHA-256 ' + (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.Substring(0, 16) + '...') }
    else { Add-Result 'FAIL' 'Platform CA' ($path + ' is missing') }
}

Invoke-Check 'Platform server reachable' {
    if (-not $serverHost) { Add-Result 'FAIL' 'Platform server reachable' 'no address to try (see Configuration)'; return }
    $client = New-Object Net.Sockets.TcpClient
    try {
        $attempt = $client.BeginConnect($serverHost, $serverPort, $null, $null)
        if ($attempt.AsyncWaitHandle.WaitOne(5000) -and $client.Connected) { Add-Result 'PASS' 'Platform server reachable' ($serverHost + ':' + [string]$serverPort + ' accepts connections') }
        else { Add-Result 'FAIL' 'Platform server reachable' ($serverHost + ':' + [string]$serverPort + ' did not answer within 5 seconds') }
    } finally { $client.Close() }
}

Invoke-Check 'Agent log' {
    $logs = Join-Path $dataDir 'logs'
    $newest = Get-ChildItem -LiteralPath $logs -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $newest) { Add-Result 'FAIL' 'Agent log' 'the agent has written no log'; return }
    $age = [int]((Get-Date).ToUniversalTime() - $newest.LastWriteTimeUtc).TotalMinutes
    if ($age -le 15) { Add-Result 'PASS' 'Agent log' ('written ' + [string]$age + ' min ago (' + $newest.Name + ')') }
    else { Add-Result 'WARN' 'Agent log' ('last written ' + [string]$age + ' min ago; a running agent writes at least every few minutes') }
}

$failed = @($results | Where-Object { $_.status -eq 'FAIL' }).Count
$warned = @($results | Where-Object { $_.status -eq 'WARN' }).Count
Write-Host ''
Write-Host ([string]$results.Count + ' checks: ' + [string]($results.Count - $failed - $warned) + ' passed, ' + [string]$warned + ' warnings, ' + [string]$failed + ' failed')

$outDir = Join-Path $env:ProgramData 'Mashura\CabinetAgent-Acceptance'
try {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $outFile = Join-Path $outDir ('acceptance-' + $env:COMPUTERNAME + '-' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + '.json')
    $report = [ordered]@{ computer = $env:COMPUTERNAME; at = (Get-Date).ToUniversalTime().ToString('o'); passed = ($failed -eq 0); results = $results }
    [IO.File]::WriteAllText($outFile, ($report | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    Write-Host ('Results written to ' + $outFile)
} catch {
    Write-Host ('The results file could not be written: ' + $_.Exception.Message)
}
if ($failed -gt 0) { exit 1 }
exit 0

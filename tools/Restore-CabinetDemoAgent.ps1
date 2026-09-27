# SAME MACHINE only: recover an installed, enrolled lab Agent without reenrollment.
# Review the kit guide and trusted release digest before an authorized maintenance window.
[CmdletBinding()]
param(
    [string]$AgentZip,
    [string]$ExpectedSha256,
    [string]$ExpectedSourceCommit,
    [string]$BackupRoot,
    [switch]$ConfirmSameMachine
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$serviceName = 'CabinetPlatformAgent'
$install = 'C:\Program Files\Mashura\CabinetAgent'
$endpoint = 'https://srv1522777.tail72f980.ts.net/'
$trusted = @('S-1-5-18','S-1-5-32-544')

function Refuse([string]$message) { throw "Recovery refused: $message" }
function Check-Path([string]$path, [bool]$exists) {
    if (![IO.Path]::IsPathRooted($path)) { Refuse 'Absolute local paths required.' }
    $full = [IO.Path]::GetFullPath($path).TrimEnd('\')
    if ($full.StartsWith('\\')) { Refuse 'Network paths refused.' }
    $part = $full
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'Reparse path refused.' }
        }
        $parent = [IO.Path]::GetDirectoryName($part)
        if (!$parent -or $parent -eq $part) { break }
        $part = $parent
    }
    if ($exists -and !(Test-Path -LiteralPath $full)) { Refuse 'Required path missing.' }
    return $full
}
function Check-Acl([string]$path, [bool]$private) {
    $acl = Get-Acl -LiteralPath $path
    $sid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $installer = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
    if ($sid -notin ($trusted + @($installer))) { Refuse 'Untrusted path owner.' }
    $mutation = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        $who = $ace.IdentityReference.Value
        if ($who -notin $trusted -and ($private -or ($who -ne $installer -and ($ace.FileSystemRights -band $mutation) -ne 0))) {
            Refuse 'Untrusted access to recovery path.'
        }
    }
}
function Check-Ancestors([string]$path) {
    $part = [IO.Path]::GetDirectoryName($path)
    while ($part) {
        Check-Path $part $true | Out-Null
        Check-Acl $part $false
        $next = [IO.Path]::GetDirectoryName($part)
        if (!$next -or $next -eq $part) { break }
        $part = $next
    }
}
function Check-Tree([string]$path) {
    Check-Path $path $true | Out-Null
    Check-Acl $path $true
    foreach ($entry in Get-ChildItem -LiteralPath $path -Force -Recurse) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'Linked tree member refused.' }
        Check-Acl $entry.FullName $true
    }
}
function Lock-Directory([string]$path) {
    & "$env:SystemRoot\System32\icacls.exe" $path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Refuse 'Could not secure recovery directory.' }
    Check-Acl $path $true
}
function Lock-File([string]$path) {
    & "$env:SystemRoot\System32\icacls.exe" $path /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Refuse 'Could not secure recovery file.' }
    Check-Acl $path $true
}
function Fingerprint([string]$path) {
    $items = @{}
    foreach ($item in @(Get-Item -LiteralPath $path -Force) + @(Get-ChildItem -LiteralPath $path -Recurse -Force)) {
        $relative = $item.FullName.Substring($path.Length).TrimStart('\')
        if ($item.PSIsContainer) { $items[$relative] = 'dir' }
        else { $items[$relative] = [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($item.FullName))) }
    }
    return $items
}
function Same-Bytes([string]$left, [string]$right) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $a = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($left)))
        $b = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($right)))
        return $a -ceq $b
    } finally { $sha.Dispose() }
}
function Same-PackageBytes([byte[]]$expected, [string]$path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $a = [BitConverter]::ToString($sha.ComputeHash($expected))
        $b = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path)))
        return $a -ceq $b
    } finally { $sha.Dispose() }
}
function Same-Tree([hashtable]$expected, [string]$path) {
    $actual = Fingerprint $path
    if ($expected.Count -ne $actual.Count) { Refuse 'Protected tree membership changed.' }
    foreach ($key in $expected.Keys) {
        if (!$actual.ContainsKey($key) -or $actual[$key] -cne $expected[$key]) { Refuse 'Protected tree content changed.' }
    }
}
function Assert-Identity([string]$path) {
    foreach ($name in @('CabinetPlatform.Agent.exe','appsettings.json','office-enrollment.json.device','state\agent-state.json')) {
        if (!(Test-Path -LiteralPath (Join-Path $path $name) -PathType Leaf)) { Refuse 'Installed identity or binary missing.' }
    }
    foreach ($overlay in Get-ChildItem -LiteralPath $path -Filter 'appsettings.*.json' -File -Force) {
        Refuse 'Runtime configuration overlay requires separate review.'
    }
    if (Test-Path -LiteralPath (Join-Path $path 'office-enrollment.json')) { Refuse 'Unexpected enrollment token on existing installation.' }
    try { $config = Get-Content -LiteralPath (Join-Path $path 'appsettings.json') -Raw | ConvertFrom-Json }
    catch { Refuse 'Existing configuration cannot be parsed.' }
    if ($config.Agent.ServerBaseUrl -cne $endpoint -or $config.Agent.OfficeEnrollmentFile -cne 'office-enrollment.json' -or
        $config.Agent.StateDirectory -cne 'C:/Program Files/Mashura/CabinetAgent/state' -or
        $config.Agent.LogDirectory -cne 'C:/Program Files/Mashura/CabinetAgent/logs' -or
        $config.Agent.Buffer.Directory -cne 'C:/Program Files/Mashura/CabinetAgent/buffer' -or
        $config.Agent.Actions.DiagnosticBundleDirectory -cne 'C:/Program Files/Mashura/CabinetAgent/bundles' -or
        $config.Agent.Actions.ExecutionMode -cne 'DiagnosticOnly') { Refuse 'Existing configuration differs from approved endpoint or paths.' }
    try { $state = Get-Content -LiteralPath (Join-Path $path 'state\agent-state.json') -Raw | ConvertFrom-Json }
    catch { Refuse 'Persisted identity cannot be parsed.' }
    if ([string]::IsNullOrWhiteSpace($state.MachineId) -or [string]::IsNullOrWhiteSpace($state.CabinetId)) { Refuse 'Persisted identity incomplete.' }
    $device = Join-Path $path 'office-enrollment.json.device'
    if ((Get-Item -LiteralPath $device).Length -lt 1 -or (Get-Item -LiteralPath $device).Length -gt 4096) { Refuse 'Original device journal missing or oversized.' }
    try { $journal = Get-Content -LiteralPath $device -Raw | ConvertFrom-Json }
    catch { Refuse 'Original device journal cannot be parsed.' }
    if ($journal.ServerBaseUrl -cne $endpoint -or $journal.MachineId -cne $state.MachineId -or
        $journal.DeviceKey -cnotmatch '^[A-Fa-f0-9]{64}$' -or $journal.Confirmed -cne $true) {
        Refuse 'Original confirmed journal does not match persisted identity and endpoint.'
    }
    # Never print the state, device key or their fingerprints.
}
function Valid-Name([string]$name) {
    return ($name -cmatch '^[A-Za-z0-9_.-]{1,240}$' -and !$name.EndsWith('.') -and
        $name.Split('.')[0] -notmatch '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$')
}
function Load-Package([IO.FileStream]$packageStream, [string]$digest, [string]$commit) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($packageStream)).Replace('-', '') }
    finally { $sha.Dispose() }
    if ($actual -cne $digest.ToUpperInvariant()) { Refuse 'Trusted package digest mismatch.' }
    $packageStream.Position = 0
    Add-Type -AssemblyName System.IO.Compression
    $archive = [IO.Compression.ZipArchive]::new($packageStream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        $files = @{}
        [long]$total = 0
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            if (!(Valid-Name $name) -or $files.ContainsKey($name.ToLowerInvariant()) -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -notin @(0, 0x8000) -or
                ($entry.ExternalAttributes -band 0x400) -ne 0 -or $entry.Length -gt 104857600) { Refuse 'Unsafe package member.' }
            if ($name -cnotin @('kit-manifest.json','appsettings.json','CabinetPlatform.Contracts.xml',
                'CabinetPlatform.Agent.deps.json','CabinetPlatform.Agent.runtimeconfig.json') -and
                $name -notmatch '(?i)\.(dll|exe)$') { Refuse 'Unclassified package member.' }
            $total += $entry.Length
            if ($total -gt 1073741824) { Refuse 'Package size limit.' }
            $member = $entry.Open()
            try {
                $memory = [IO.MemoryStream]::new()
                try { $member.CopyTo($memory); $bytes = $memory.ToArray() }
                finally { $memory.Dispose() }
            } finally { $member.Dispose() }
            if ($bytes.Length -ne $entry.Length) { Refuse 'Package member length changed.' }
            $files[$name.ToLowerInvariant()] = [pscustomobject]@{ Name = $name; Bytes = $bytes }
        }
        foreach ($name in @('kit-manifest.json','appsettings.json','CabinetPlatform.Agent.exe')) {
            if (!$files.ContainsKey($name.ToLowerInvariant())) { Refuse 'Package member missing.' }
        }
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        try { $manifest = $utf8.GetString($files['kit-manifest.json'].Bytes) | ConvertFrom-Json }
        catch { Refuse 'Package manifest cannot be parsed.' }
        if (@($manifest.PSObject.Properties).Count -ne 6 -or $manifest.schema -ne 1 -or
            $manifest.component -cne 'agent' -or $manifest.signed -ne $false -or
            $manifest.endpoint -cne $endpoint -or $manifest.sourceCommit -cne $commit -or
            @($manifest.sha256.PSObject.Properties).Count -ne ($files.Count - 1)) { Refuse 'Package manifest differs.' }
        foreach ($property in $manifest.sha256.PSObject.Properties) {
            $key = $property.Name.ToLowerInvariant()
            if (!$files.ContainsKey($key) -or $key -eq 'kit-manifest.json' -or
                $property.Value -cnotmatch '^[A-F0-9]{64}$') { Refuse 'Manifest membership invalid.' }
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($files[$key].Bytes)).Replace('-', '') }
            finally { $sha.Dispose() }
            if ($hash -cne $property.Value) { Refuse 'Package member changed.' }
        }
        try { $config = $utf8.GetString($files['appsettings.json'].Bytes) | ConvertFrom-Json }
        catch { Refuse 'Package configuration cannot be parsed.' }
        if ($config.Agent.ServerBaseUrl -cne $endpoint -or $config.Agent.OfficeEnrollmentFile -cne 'office-enrollment.json' -or
            $config.Agent.StateDirectory -cne 'C:/Program Files/Mashura/CabinetAgent/state' -or
            $config.Agent.LogDirectory -cne 'C:/Program Files/Mashura/CabinetAgent/logs' -or
            $config.Agent.Buffer.Directory -cne 'C:/Program Files/Mashura/CabinetAgent/buffer' -or
            $config.Agent.Actions.DiagnosticBundleDirectory -cne 'C:/Program Files/Mashura/CabinetAgent/bundles' -or
            $config.Agent.Actions.ExecutionMode -cne 'DiagnosticOnly') { Refuse 'Package configuration invalid.' }
        return $files
    } finally { $archive.Dispose() }
}
function Invoke-Sc([string[]]$arguments) {
    & "$env:SystemRoot\System32\sc.exe" @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { Refuse 'Service control failed; inspect protected backup.' }
}
function Service-Recovery {
    $sc = "$env:SystemRoot\System32\sc.exe"
    $actions = & $sc qfailure $serviceName
    if ($LASTEXITCODE -ne 0) { Refuse 'Cannot capture service recovery settings.' }
    $flag = & $sc qfailureflag $serviceName
    if ($LASTEXITCODE -ne 0) { Refuse 'Cannot capture service failure flag.' }
    return (($actions -join "`n") + "`n" + ($flag -join "`n"))
}
function Service-Read {
    $s = Get-CimInstance Win32_Service -Filter "Name='CabinetPlatformAgent'"
    if (!$s) { return $null }
    return [pscustomobject]@{ State=$s.State; StartName=$s.StartName; StartMode=$s.StartMode;
        PathName=$s.PathName; DisplayName=$s.DisplayName }
}
function Service-WaitAbsent {
    for ($i = 0; $i -lt 30; $i++) {
        if (!(Service-Read)) { return }
        Start-Sleep -Seconds 1
    }
    Refuse 'Service deletion pending; no forced termination.'
}
function Service-Stop {
    Stop-Service -Name $serviceName -ErrorAction Stop
    (Get-Service -Name $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    if ((Service-Read).State -ne 'Stopped') { Refuse 'Service did not stop gracefully.' }
}
function Service-Delete { Invoke-Sc @('delete', $serviceName); Service-WaitAbsent }
function Service-CreateDisabled {
    # sc.exe gets one binPath value with embedded quotes; verify SCM readback before start.
    Invoke-Sc @('create', $serviceName, 'binPath=', ('"' + $install + '\CabinetPlatform.Agent.exe"'),
        'DisplayName=', 'Mashura Cabinet Support Agent', 'start=', 'disabled', 'obj=', 'LocalSystem')
    Invoke-Sc @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/60000/restart/120000/restart/300000')
    Invoke-Sc @('failureflag', $serviceName, '1')
}
function Service-SetStart([string]$start) { Invoke-Sc @('config', $serviceName, 'start=', $start) }
function Service-Start {
    Start-Service -Name $serviceName -ErrorAction Stop
    (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    if ((Service-Read).State -ne 'Running') { Refuse 'Service did not reach Running.' }
}
function Assert-Service([string]$mode, [string]$state) {
    $svc = Service-Read
    if (!$svc -or $svc.StartName -cne 'LocalSystem' -or $svc.StartMode -cne $mode -or
        $svc.PathName -cne ('"' + $install + '\CabinetPlatform.Agent.exe"') -or
        $svc.DisplayName -cne 'Mashura Cabinet Support Agent' -or $svc.State -cne $state) {
        Refuse 'Service definition differs from reviewed baseline.'
    }
}
function Invoke-Recovery([hashtable]$package, [string]$backupParent) {
    Assert-Service 'Auto' 'Running'
    $recovery = Service-Recovery
    Check-Tree $install
    # The live credential journal can hold an exclusive lock. Inspect bytes only
    # after the graceful stop, and freeze the baseline at that point.
    $original = $null
    # Secure a new recovery root before stopping. Never reuse or remove a backup.
    $run = Join-Path $backupParent ('agent-recovery-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $run -ErrorAction Stop | Out-Null
    Lock-Directory $run
    $snapshot = Join-Path $run 'original-copy'
    $retired = Join-Path $run 'original-installed'
    $failed = Join-Path $run 'failed-replacement'
    $stopAttempted = $false; $stopped = $false; $deleted = $false; $moved = $false; $started = $false
    try {
        $stopAttempted = $true
        Service-Stop
        $stopped = $true
        Check-Tree $install
        Assert-Identity $install
        $original = Fingerprint $install
        Copy-Item -LiteralPath $install -Destination $snapshot -Recurse -ErrorAction Stop
        foreach ($entry in @(Get-Item -LiteralPath $snapshot) + @(Get-ChildItem -LiteralPath $snapshot -Recurse -Force)) {
            if ($entry.PSIsContainer) { Lock-Directory $entry.FullName } else { Lock-File $entry.FullName }
        }
        Check-Tree $snapshot
        Same-Tree $original $snapshot
        # The snapshot is retained even if any subsequent operation fails.
        Service-Delete
        $deleted = $true
        Move-Item -LiteralPath $install -Destination $retired -ErrorAction Stop
        $moved = $true
        New-Item -ItemType Directory -Path $install -ErrorAction Stop | Out-Null
        Lock-Directory $install
        foreach ($entry in $package.Values) {
            if ($entry.Name -ceq 'kit-manifest.json' -or $entry.Name -ceq 'appsettings.json') { continue }
            $path = Join-Path $install $entry.Name
            [IO.File]::WriteAllBytes($path, $entry.Bytes)
            Lock-File $path
        }
        # Restore every non-package member, including original config, device journal,
        # pending results, buffer and logs, before registration or first start.
        foreach ($entry in Get-ChildItem -LiteralPath $snapshot -Recurse -Force) {
            $relative = $entry.FullName.Substring($snapshot.Length).TrimStart('\')
            $target = Join-Path $install $relative
            if ($entry.PSIsContainer) {
                New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
                Lock-Directory $target
            } elseif ($entry.Name -ceq 'appsettings.json' -or !$package.ContainsKey($entry.Name.ToLowerInvariant())) {
                Copy-Item -LiteralPath $entry.FullName -Destination $target -ErrorAction Stop
                Lock-File $target
            }
        }
        Check-Tree $install
        Assert-Identity $install
        # Compare all preserved members privately. Package members may be replaced.
        foreach ($entry in Get-ChildItem -LiteralPath $snapshot -Recurse -Force -File) {
            if ($entry.Name -cne 'appsettings.json' -and $package.ContainsKey($entry.Name.ToLowerInvariant())) { continue }
            $relative = $entry.FullName.Substring($snapshot.Length).TrimStart('\')
            $copy = Join-Path $install $relative
            if (!(Test-Path -LiteralPath $copy -PathType Leaf) -or !(Same-Bytes $entry.FullName $copy)) {
                Refuse 'Original configuration or identity changed during restore.'
            }
        }
        foreach ($entry in $package.Values) {
            if ($entry.Name -cin @('kit-manifest.json','appsettings.json')) { continue }
            $copy = Join-Path $install $entry.Name
            if (!(Test-Path -LiteralPath $copy -PathType Leaf) -or !(Same-PackageBytes $entry.Bytes $copy)) {
                Refuse 'Replacement bytes changed before first start.'
            }
        }
        Service-CreateDisabled
        Assert-Service 'Disabled' 'Stopped'
        if ((Service-Recovery) -cne $recovery) { Refuse 'Service recovery policy differs from original.' }
        Assert-Identity $install
        Service-SetStart 'demand'
        Assert-Service 'Manual' 'Stopped'
        # Once start is requested, the journal may advance. Never restore an older
        # snapshot automatically after this boundary, even if Start-Service throws.
        $started = $true
        Service-Start
        Service-SetStart 'auto'
        Assert-Service 'Auto' 'Running'
        Write-Output "Recovery start requested. Backup retained at $run. Running does not prove authentication."
    } catch {
        $cause = $_.Exception.Message
        if ($started) {
            try { Service-SetStart 'disabled'; if ((Service-Read).State -eq 'Running') { Service-Stop } }
            catch { Write-Warning 'Could not fail-stop replacement; manual isolation required.' }
            throw "Poststart failure: $cause. Do not restore older state; preserve current journal and backup at $run. Verify manually."
        }
        try {
            # A command can throw after its external effect. Reconcile actual paths
            # and SCM state before deciding whether rollback must recreate them.
            if (!$deleted -and !(Service-Read)) { $deleted = $true }
            if (!$moved -and (Test-Path -LiteralPath $retired)) { $moved = $true }
            if ($deleted -and (Service-Read)) { Service-Delete }
            if ($moved) {
                if (Test-Path -LiteralPath $install) { Move-Item -LiteralPath $install -Destination $failed -ErrorAction Stop }
                Move-Item -LiteralPath $retired -Destination $install -ErrorAction Stop
                Same-Tree $original $install
            }
            if ($deleted) {
                Service-CreateDisabled
                Assert-Service 'Disabled' 'Stopped'
                if ((Service-Recovery) -cne $recovery) { Refuse 'Original service recovery policy not restored.' }
                Service-SetStart 'auto'
                Assert-Service 'Auto' 'Stopped'
            }
            if ($stopAttempted -and (Service-Read).State -eq 'Stopped') { Service-Start; Assert-Service 'Auto' 'Running' }
        } catch { throw "Rollback incomplete after $cause. Do not start or remove anything; protected backup at $run. Recovery error: $($_.Exception.Message)" }
        throw "Recovery failed before start: $cause. Original service restored; backup retained at $run."
    }
}

# No arguments means no action. The transaction is never reached from AST-only fixtures.
if (!$ConfirmSameMachine -or !$AgentZip -or !$ExpectedSha256 -or !$ExpectedSourceCommit -or !$BackupRoot) {
    Refuse 'Explicit same-machine confirmation, package, trusted digest, source commit and backup root required.'
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $PSVersionTable.PSVersion.Major -lt 5 -or
    ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -lt 1)) { Refuse 'Windows PowerShell 5.1 or later required.' }
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'Elevated administrator required.' }
if ($ExpectedSha256 -cnotmatch '^[A-Fa-f0-9]{64}$' -or $ExpectedSourceCommit -cnotmatch '^[a-f0-9]{40}$') { Refuse 'Trusted digest and commit required.' }
$zip = Check-Path $AgentZip $true
$backup = Check-Path $BackupRoot $true
$install = Check-Path $install $true
if ($backup -match '(?i)(^|\\)Desktop(\\|$)' -or !(Test-Path -LiteralPath $backup -PathType Container) -or
    $backup -ieq $install -or $backup.StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $install.StartsWith($backup + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $zip.StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $zip.StartsWith($backup + '\', [StringComparison]::OrdinalIgnoreCase)) { Refuse 'Unsafe or overlapping recovery paths.' }
foreach ($path in @($zip,$backup,$install)) { Check-Ancestors $path; Check-Acl $path ($path -ne $zip) }
$packageStream = [IO.FileStream]::new($zip, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $package = Load-Package $packageStream $ExpectedSha256 $ExpectedSourceCommit
    Invoke-Recovery $package $backup
} finally { $packageStream.Dispose() }

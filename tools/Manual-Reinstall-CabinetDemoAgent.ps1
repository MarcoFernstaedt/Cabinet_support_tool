# Same-device manual reinstall. Prepare removes only the admitted service and archives
# its stopped installation. Restore uses only that exact protected backup on this boot.
[CmdletBinding(DefaultParameterSetName='Prepare')]
param(
    [switch]$Prepare,
    [string]$BackupRoot,
    [switch]$Restore,
    [string]$BackupHandle,
    [string]$AgentZip,
    [string]$ExpectedSha256,
    [string]$ExpectedSourceCommit,
    [switch]$ConfirmSameMachine
)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if (($Prepare -eq $Restore) -or !$ConfirmSameMachine -or
    ($Prepare -and !$BackupRoot) -or ($Restore -and (!$BackupHandle -or !$AgentZip -or !$ExpectedSha256 -or !$ExpectedSourceCommit)) -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or
    [IntPtr]::Size -ne 8) { throw 'Explicit same-machine confirmation and x64 Windows PowerShell 5.1 required.' }
$principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevation required.' }
$manualArguments=@{ Parent=$BackupRoot; Handle=$BackupHandle; Zip=$AgentZip;
    Digest=$ExpectedSha256; Commit=$ExpectedSourceCommit; Preparing=[bool]$Prepare }
# Import the actual production path/ACL/package/SCM/process implementation, not a copy.
try { . (Join-Path $PSScriptRoot 'Restore-CabinetDemoAgent.ps1') }
catch { if ($_.Exception.Message -notlike '*Explicit same-machine confirmation*') { throw } }
Add-Type -AssemblyName System.Security

function Host-Binding {
    $key=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
    try { $machine=[string]$key.GetValue('MachineGuid') } finally { $key.Dispose() }
    $scm=@(Get-CimInstance Win32_Process -Filter "Name='services.exe'")
    if (!$machine -or $scm.Count -ne 1 -or !$scm[0].CreationDate) { Refuse 'Host or current SCM boot witness unavailable.' }
    return [pscustomobject]@{Machine=$machine; Boot=[string]$scm[0].CreationDate}
}
function Seal-Record([string]$path, $record) {
    $plain=[Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 20 -Compress))
    $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
    [IO.File]::WriteAllBytes($path,$cipher); Lock-File $path
}
function Read-Record([string]$path) {
    $plain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
    return ([Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json)
}
function Same-Definition($wanted) {
    $actual=Service-Recovery
    foreach ($field in @('Type','Error','Image','Group','Dependencies','Account','Display','Description',
        'Delayed','Sid','Privileges','TriggerCount','Dacl','OwnerGroup','Policy')) {
        if ([string]$actual.$field -cne [string]$wanted.$field) { Refuse "Service definition mismatch: $field" }
    }
}
function Snapshot-FromRecord($record) {
    $value=[CabinetRecoveryDefinition+Snapshot]::new()
    foreach ($field in @('Type','Start','Error','Reset','Count','Sid','TriggerCount','FailureFlag','Delayed',
        'Image','Group','Dependencies','Account','Display','Description','Privileges','Dacl','OwnerGroup',
        'ActionSequence','Reboot','Command')) { $value.$field=$record.$field }
    return $value
}
function Compare-Copy([string]$path, $expected) {
    $current=Fingerprint $path
    if ($current.Count -ne @($expected).Count) { Refuse 'Backup membership changed.' }
    foreach ($entry in $expected) {
        if (!$current.ContainsKey([string]$entry.Path) -or $current[[string]$entry.Path] -cne $entry.Hash) { Refuse 'Backup bytes changed.' }
    }
}
function Check-PrivateBackup([string]$path) {
    $path=Check-Path $path $true
    if ($path -match '(?i)(^|\\)Desktop(\\|$)' -or
        $path.StartsWith($install+'\',[StringComparison]::OrdinalIgnoreCase) -or
        $install.StartsWith($path+'\',[StringComparison]::OrdinalIgnoreCase)) { Refuse 'Overlapping or desktop backup.' }
    Check-Ancestors $path; Check-Tree $path
    return $path
}
function Prepare-Removal([string]$parent) {
    $parent=Check-PrivateBackup $parent

    $install=Check-Path $script:install $true
    Check-Ancestors $install; Check-Tree $install
    Assert-Service 'Auto' 'Running'; Service-Admission; Assert-ExecutionEnvironment
    $definition=Service-Recovery
    $hostId=Host-Binding
    $run=Join-Path $parent ('manual-reinstall-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $run -ErrorAction Stop | Out-Null
    Lock-Directory $run
    $copy=Join-Path $run 'original-copy'; $archive=Join-Path $run 'original-installed'
    $stopRequested=$false; $deleted=$false
    try {
        $stopRequested=$true
        Service-SetStart 'disabled'; Service-Stop; Service-EnsureStopped
        Assert-ExecutionEnvironment
        Check-Tree $install; Assert-Identity $install
        $fingerprint=Fingerprint $install
        Copy-Item -LiteralPath $install -Destination $copy -Recurse -ErrorAction Stop
        foreach ($entry in @(Get-Item -LiteralPath $copy) + @(Get-ChildItem -LiteralPath $copy -Recurse -Force)) {
            if ($entry.PSIsContainer) { Lock-Directory $entry.FullName } else { Lock-File $entry.FullName }
        }
        Check-Tree $copy; Same-Tree $fingerprint $copy
        $members=@($fingerprint.GetEnumerator() | ForEach-Object { [pscustomobject]@{Path=$_.Key; Hash=$_.Value} })
        $record=[pscustomobject]@{Schema=1; Host=$hostId; Definition=$definition;
            Fingerprint=$members; Service=$serviceName; Install=$install}
        Seal-Record (Join-Path $run 'record.dpapi') $record
        # Capture is complete before any deletion. A competing restart is not removable.
        Service-EnsureStopped; Assert-Service 'Disabled' 'Stopped'; Same-Definition $definition
        Move-Item -LiteralPath $install -Destination $archive -ErrorAction Stop
        Same-Tree $fingerprint $archive
        Service-EnsureStopped; Service-Delete
        $deleted=$true
        if (Service-Read) { Refuse 'Service deletion is still pending.' }
        Write-Output "MANUAL_REINSTALL_HANDLE=$run"
        Write-Output 'Original service absent; stopped original archived. No enrollment or server change.'
    } catch {
        $cause=$_.Exception.Message
        if (!$deleted -and [CabinetRecoveryDefinition]::Exists($serviceName)) {
            try {
                if (!(Test-Path -LiteralPath $install) -and (Test-Path -LiteralPath $archive)) {
                    Move-Item -LiteralPath $archive -Destination $install -ErrorAction Stop
                }
                if (Test-Path -LiteralPath $install) { Assert-Identity $install }
                Service-SetStart 'auto'
                if ((Service-WaitTerminal) -eq 'Stopped') { Service-Start }
                Assert-Service 'Auto' 'Running'
            } catch { throw "Prepare failed: $cause. Rollback unresolved at ${run}: $($_.Exception.Message)" }
            throw "Prepare failed before service deletion: $cause. Original running; retained private run at $run."
        }
        throw "Prepare interrupted after deletion or deletion pending: $cause. Keep private backup $run. Do not create another backup or reenroll."
    }
}
function Restore-Installation([string]$handle, [string]$zipPath, [string]$digest, [string]$commit) {
    Service-Recovery -LoadOnly
    if ($digest -cnotmatch '^[A-Fa-f0-9]{64}$' -or $commit -cnotmatch '^[a-f0-9]{40}$') { Refuse 'Trusted artifact identifiers required.' }
    $handle=Check-PrivateBackup $handle
    $zipPath=Check-Path $zipPath $true; Check-Ancestors $zipPath; Check-Acl $zipPath $false
    if ($zipPath.StartsWith($handle+'\',[StringComparison]::OrdinalIgnoreCase)) { Refuse 'Package overlaps protected backup.' }
    $record=Read-Record (Join-Path $handle 'record.dpapi')
    $hostId=Host-Binding
    if ($record.Schema -ne 1 -or $record.Service -cne $serviceName -or $record.Install -cne $install -or
        $record.Host.Machine -cne $hostId.Machine -or $record.Host.Boot -cne $hostId.Boot) {
        Refuse 'Backup provenance or same-boot execution witness differs. Do not restart after reboot.'
    }
    if (Test-Path -LiteralPath $install) { Refuse 'Install path already occupied.' }
    if ([CabinetRecoveryDefinition]::Exists($serviceName)) { Refuse 'Service exists or is marked for deletion.' }
    $copy=Join-Path $handle 'original-copy'; $archive=Join-Path $handle 'original-installed'
    Check-Tree $copy; Check-Tree $archive
    Compare-Copy $copy $record.Fingerprint; Compare-Copy $archive $record.Fingerprint
    Assert-Identity $copy
    $value=Snapshot-FromRecord $record.Definition
    if ($value.Image -cne ('"'+$install+'\CabinetPlatform.Agent.exe"') -or
        $value.Dacl -cne 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)' -or
        $value.Group -or $value.Dependencies -or $value.Delayed -or $value.Sid -ne 0 -or
        $value.Privileges -or $value.TriggerCount -ne 0 -or $value.Reboot -or $value.Command) {
        Refuse 'Unsupported original service definition.'
    }
    $stream=[IO.FileStream]::new($zipPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $package=Load-Package $stream $digest $commit
        $created=$false; $startRequested=$false
        try {
            # Install only the reviewed package members. Preserve all original non-package
            # state and configuration by exact relative path from the stopped original.
            Copy-Item -LiteralPath $copy -Destination $install -Recurse -ErrorAction Stop
            foreach ($entry in $package.Values) {
                if ($entry.Name -cin @('kit-manifest.json','appsettings.json')) { continue }
                $path=Join-Path $install $entry.Name
                [IO.File]::WriteAllBytes($path,$entry.Bytes); Lock-File $path
            }
            Check-Tree $install; Assert-Identity $install
            $preserved=Preserved-Members $copy $package
            $restored=Preserved-Members $install $package
            if ($preserved.Count -ne $restored.Count) { Refuse 'Original state membership changed.' }
            foreach ($key in $preserved.Keys) {
                if (!$restored.ContainsKey($key) -or $restored[$key] -cne $preserved[$key]) { Refuse 'Original state bytes changed.' }
            }
            foreach ($entry in $package.Values) {
                if ($entry.Name -cin @('kit-manifest.json','appsettings.json')) { continue }
                if (!(Same-PackageBytes $entry.Bytes (Join-Path $install $entry.Name))) { Refuse 'Package bytes changed.' }
            }
            if ([CabinetRecoveryDefinition]::Exists($serviceName)) { Refuse 'Service appeared before creation.' }
            [CabinetRecoveryDefinition]::CreateFromSnapshot($serviceName,$value)
            $created=$true
            Assert-Service 'Disabled' 'Stopped'; Same-Definition $value
            # A stopped service has no live process. The persisted witness is tied to
            # this SCM boot; inspect machine and service sources before first start.
            $script:launchWitness=(Host-Binding).Boot
            Assert-ExecutionEnvironment
            Service-SetStart 'demand'; Assert-Service 'Manual' 'Stopped'
            $startRequested=$true
            Service-Start
            Service-SetStart 'auto'; Assert-Service 'Auto' 'Running'; Same-Definition $value
            Write-Output 'Manual same-device reinstall started. Running does not prove authentication.'
        } catch {
            $cause=$_.Exception.Message
            if ($startRequested) {
                try {
                    Service-SetStart 'disabled'
                    if ((Service-WaitTerminal) -eq 'Running') { Service-Stop }
                    Service-EnsureStopped
                } catch { throw "Poststart fail-stop unresolved: $cause. Preserve current journal at $install; $($_.Exception.Message)" }
                throw "Poststart fail-stopped: $cause. Do not restore the older snapshot over current state at $install."
            }
            # No start was requested; leave private original and any partial install
            # untouched for inspection rather than attempting an unsafe second create.
            throw "Prestart install incomplete: $cause. Do not start; preserve backup $handle and inspect disabled registration."
        }
    } finally { $stream.Dispose() }
}
if ($manualArguments.Preparing) { Prepare-Removal $manualArguments.Parent }
else { Restore-Installation $manualArguments.Handle $manualArguments.Zip $manualArguments.Digest $manualArguments.Commit }

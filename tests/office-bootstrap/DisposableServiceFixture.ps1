# Separate process boundary for disposable native service tests. Never run on a host PC.
param([ValidateSet('MachineGate','Gate','Cleanup')][string]$Action,
      [string]$Manifest)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
function Assert-DisposableMachine {
    $system=Get-CimInstance Win32_ComputerSystem
    $product=Get-CimInstance Win32_ComputerSystemProduct
    $key=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
    try { $machine=[string]$key.GetValue('MachineGuid') } finally { $key.Dispose() }
    # Both the actual hardware identity and an independent VM authorization are required.
    if (!$system -or !$product -or !$machine -or
        ($system.Manufacturer+' '+$system.Model) -notmatch '(?i)(VMware|VirtualBox|QEMU|KVM|Hyper-V|Virtual Machine)' -or
        $product.UUID -match '^0{8}-' -or $product.UUID -match '^F{8}-') {
        throw 'Disposable VM isolation required; physical hosts are refused.'
    }
    return [pscustomobject]@{ Machine=$machine; UUID=[string]$product.UUID }
}
function Assert-Fixture([string]$path) {
    $vm=Assert-DisposableMachine
    if (!$path -or !(Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Exact target manifest missing.' }
    $data=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $service=[string]$data.Service
    if ($service -ceq 'CabinetPlatformAgent') { throw 'Production service forbidden.' }
    if ($service -cnotmatch '^CabinetManualProbe-[a-f0-9]{32}$' -or
        $data.Machine -cne $vm.Machine -or $data.UUID -cne $vm.UUID -or
        $data.Scenario -cnotin @('success','prestart','poststart','tamper','inherited-read','owner-group','preshutdown','pending-deletion','alias','audit-sacl','destination-replacement')) {
        throw 'Fixture identity or VM authorization mismatch.'
    }
    $root=[IO.Path]::GetFullPath((Join-Path $env:ProgramData $service)).TrimEnd('\')
    $actual=[IO.Path]::GetFullPath([string]$data.Root).TrimEnd('\')
    $exe=Join-Path $root 'Synthetic\CabinetPlatform.Agent.exe'
    if ($actual -cne $root -or $data.Image -cne $exe -or
        $data.Sha256 -cnotmatch '^[A-F0-9]{64}$' -or
        [IO.Path]::GetFullPath($path) -cne (Join-Path $root 'fixture-target.json')) {
        throw 'Fixture target/path outside exact disposable root.'
    }
    $archived=@(Get-ChildItem -LiteralPath (Join-Path $root 'Backup') -Directory -Filter 'manual-reinstall-*' -ErrorAction SilentlyContinue)
    $candidates=@($exe)
    foreach ($run in $archived) { $candidates+=Join-Path $run.FullName 'original-installed\CabinetPlatform.Agent.exe' }
    $present=@($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($present.Count -eq 0 -or @($present | Where-Object {
        (Get-Item -LiteralPath $_ -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash -cne $data.Sha256
    }).Count -gt 0) {
        throw 'Inert executable missing or changed.'
    }
    $item=Get-Item -LiteralPath $root -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Fixture root alias refused.' }
    $ancestor=Get-Item -LiteralPath $env:ProgramData -Force
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ProgramData alias refused.' }
    $svc=Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'")
    if ($svc -and ($svc.Name -cne $service -or $svc.PathName -cne ('"'+$exe+'"') -or
                    $svc.StartName -cne 'LocalSystem')) {
        throw 'Service binding mismatch; leave fixture for manual review.'
    }
    return [pscustomobject]@{Service=$service; Root=$root; Image=$exe; Registration=$svc}
}
try {
    if ($Action -eq 'MachineGate') { Assert-DisposableMachine | Out-Null; Write-Output 'DISPOSABLE_VM_GATE_PASS'; exit 0 }
    $target=Assert-Fixture $Manifest
    if ($Action -eq 'Gate') { Write-Output 'EXACT_FIXTURE_GATE_PASS'; exit 0 }
    if ($target.Registration) {
        # Recheck immediately before each service mutation, never use caller variables.
        $target=Assert-Fixture $Manifest
        if ($target.Registration.State -cne 'Stopped') {
            Stop-Service -Name $target.Service -ErrorAction Stop
            (Get-Service -Name $target.Service).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
        }
        $target=Assert-Fixture $Manifest
        & "$env:SystemRoot\System32\sc.exe" delete $target.Service | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Exact fixture delete request failed.' }
    }
    for ($i=0;$i -lt 30;$i++) {
        if (!(Get-Service -Name $target.Service -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 1
    }
    if (Get-Service -Name $target.Service -ErrorAction SilentlyContinue) { throw 'Fixture deletion pending; retain files.' }
    $target=Assert-Fixture $Manifest
    foreach ($member in Get-ChildItem -LiteralPath $target.Root -Recurse -Force) {
        if (($member.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Linked fixture tree refused; retain files for exact review.'
        }
    }
    $target=Assert-Fixture $Manifest
    Remove-Item -LiteralPath $target.Root -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $target.Root) { throw 'Fixture root cleanup incomplete.' }
    Write-Output 'EXACT_FIXTURE_CLEANUP_PASS'
    exit 0
} catch {
    [Console]::Error.WriteLine("FIXTURE_REFUSED: $($_.Exception.Message)")
    exit 1
}

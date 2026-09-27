# Synthetic native recovery tests. AST imports definitions only; never runs the entry point.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sourceHelper = Join-Path $PSScriptRoot '..\..\tools\Restore-CabinetDemoAgent.ps1'
if (!(Test-Path -LiteralPath $sourceHelper)) { $sourceHelper = Join-Path $PSScriptRoot 'Restore-CabinetDemoAgent.ps1' }
$helper = (Resolve-Path -LiteralPath $sourceHelper).Path
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "Recovery helper parse error: $($errors[0])" }
$definitions = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] })
foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }
$serviceName = 'CabinetPlatformAgent'
$endpoint = 'https://srv1522777.tail72f980.ts.net/'
$trusted = @('S-1-5-18','S-1-5-32-544')
$script:checks = 0
$script:journalLock = $null
function Pass([bool]$condition, [string]$label) {
    if (!$condition) { throw "FAIL $label" }
    $script:checks++; Write-Output "PASS $label"
}
function Must-Fail([scriptblock]$action, [string]$label) {
    try { & $action | Out-Null } catch { Pass $true $label; return }
    throw "Expected refusal: $label"
}
function Service-Read {
    if (!$script:exists) { return $null }
    return [pscustomobject]@{ State=$script:state; StartName='LocalSystem'; StartMode=$script:mode;
        PathName=('"' + $install + '\CabinetPlatform.Agent.exe"'); DisplayName='Mashura Cabinet Support Agent' }
}
function Service-Recovery { return [pscustomobject]@{Policy='synthetic-recovery-policy'} }
function Service-Admission {}
function Assert-ExecutionEnvironment {} # Synthetic adapter only.
function Service-Stop {
    $script:events += 'stop'
    if ($script:journalLock) { $script:journalLock.Dispose(); $script:journalLock = $null }
    if ($script:failStage -eq 'stop') { $script:state = 'Stopped'; throw 'injected stop error after stopping' }
    $script:state = 'Stopped'
}
function Service-Delete {
    $script:events += 'delete'
    if ($script:failStage -eq 'delete') { throw 'injected delete failure' }
    $script:exists = $false
}
function Service-CreateDisabled {
    $script:events += 'create'
    $script:exists = $true; $script:mode = 'Disabled'; $script:state = 'Stopped'
    if ($script:failStage -eq 'create') { $script:failStage = ''; throw 'injected partially created service failure' }
}
function Service-SetStart([string]$start) {
    $script:events += ('mode-' + $start)
    if ($script:failStage -eq 'mode' -and $start -eq 'demand') { throw 'injected configuration failure' }
    $script:mode = @{auto='Auto'; demand='Manual'; disabled='Disabled'}[$start]
}
function Service-Start {
    $script:events += 'start'
    if ($script:failStage -eq 'start') { throw 'injected ambiguous start failure' }
    $script:restoredAtStart = ((Test-Path -LiteralPath (Join-Path $install 'office-enrollment.json.device')) -and
        (Test-Path -LiteralPath (Join-Path $install 'state\agent-state.json')) -and
        ([IO.File]::ReadAllText((Join-Path $install 'state\agent-state.json'))) -like '*synthetic-cabinet*')
    if (!$script:restoredAtStart) { throw 'identity absent at first service start' }
    $script:state = 'Running'
}
$root = Join-Path $env:TEMP ('cabinet-recovery-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $install = Join-Path $root 'Cabinet Agent'
    $backup = Join-Path $root 'backups'
    New-Item -ItemType Directory -Path $backup | Out-Null
    Lock-Directory $backup
    function Fixture {
        if (Test-Path -LiteralPath $install) { Remove-Item -LiteralPath $install -Recurse -Force }
        New-Item -ItemType Directory -Path $install | Out-Null
        Lock-Directory $install
        foreach ($directory in @('state','buffer','logs')) {
            $path = Join-Path $install $directory
            New-Item -ItemType Directory -Path $path | Out-Null
            Lock-Directory $path
        }
        $script:syntheticConfig = @{Agent=@{ServerBaseUrl=$endpoint; OfficeEnrollmentFile='office-enrollment.json';
            StateDirectory='C:/Program Files/Mashura/CabinetAgent/state';
            LogDirectory='C:/Program Files/Mashura/CabinetAgent/logs';
            Buffer=@{Directory='C:/Program Files/Mashura/CabinetAgent/buffer'};
            Actions=@{ExecutionMode='DiagnosticOnly'; DiagnosticBundleDirectory='C:/Program Files/Mashura/CabinetAgent/bundles'}}} | ConvertTo-Json -Depth 10
        $files = @{'CabinetPlatform.Agent.exe'='old-binary'; 'appsettings.json'=$script:syntheticConfig;
            'office-enrollment.json.device'='{"ServerBaseUrl":"https://srv1522777.tail72f980.ts.net/","MachineId":"synthetic-id","DeviceKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","Confirmed":true}'; 'state\agent-state.json'='{"MachineId":"synthetic-id","CabinetId":"synthetic-cabinet"}';
            'buffer\pending.txt'='pending'; 'buffer\CabinetPlatform.Agent.exe'='nested pending'; 'logs\old.txt'='history'}
        foreach ($name in $files.Keys) {
            $path = Join-Path $install $name
            [IO.File]::WriteAllText($path, $files[$name]); Lock-File $path
        }
        $script:exists = $true; $script:state = 'Running'; $script:mode = 'Auto'; $script:events = @()
    }
    $script:failStage = ''
    # Real quoted SCM readback is tested by Test-RecoveryScmProbe.ps1.
    $package = @{'cabinetplatform.agent.exe'=[pscustomobject]@{Name='CabinetPlatform.Agent.exe'; Bytes=[Text.Encoding]::UTF8.GetBytes('new-binary')};
        'kit-manifest.json'=[pscustomobject]@{Name='kit-manifest.json'; Bytes=[byte[]]@()}}
    Must-Fail { Assert-Service 'Auto' 'Stopped' } 'requires running original service'
    Fixture
    Must-Fail { Assert-Identity (Join-Path $root 'missing') } 'refuses absent identity'
    $devicePath = Join-Path $install 'office-enrollment.json.device'
    $originalDevice = [IO.File]::ReadAllText($devicePath)
    [IO.File]::WriteAllText($devicePath, $originalDevice.Replace('synthetic-id','other-id'))
    Must-Fail { Assert-Identity $install } 'journal machine mismatch refused without new enrollment'
    [IO.File]::WriteAllText($devicePath, $originalDevice)
    $overlay = Join-Path $install 'appsettings.Production.json'
    [IO.File]::WriteAllText($overlay, '{}'); Lock-File $overlay
    Must-Fail { Assert-Identity $install } 'runtime overlay refused'
    Remove-Item -LiteralPath $overlay -Force
    $token = Join-Path $install 'office-enrollment.json'
    [IO.File]::WriteAllText($token, '{}'); Lock-File $token
    Must-Fail { Assert-Identity $install } 'fresh enrollment input refused on enrolled machine'
    Remove-Item -LiteralPath $token -Force
    Check-Acl 'C:\' $false
    Pass $true 'ordinary system drive creation ACE does not authorize existing child replacement'
    $unsafeParent = Join-Path $root 'unsafe-ancestor'
    New-Item -ItemType Directory -Path $unsafeParent | Out-Null
    Lock-Directory $unsafeParent
    $unsafeAcl = Get-Acl -LiteralPath $unsafeParent
    $untrusted = [Security.Principal.SecurityIdentifier]::new('S-1-5-11')
    $unsafeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($untrusted,
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
        [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $unsafeParent -AclObject $unsafeAcl
    Must-Fail { Check-Acl $unsafeParent $false } 'ancestor delete-child right refused'
    Pass ([bool](Get-Command Assert-EnvironmentEntries -ErrorAction SilentlyContinue)) 'environment admission helper exists'
    $env:Agent__OfficeEnrollmentFile = 'fresh-synthetic.json'
    Must-Fail { Assert-EnvironmentEntries @([pscustomobject]@{Key='Agent__OfficeEnrollmentFile';Value=$env:Agent__OfficeEnrollmentFile}) } 'configuration override refused'
    Remove-Item Env:Agent__OfficeEnrollmentFile
    Must-Fail { Assert-EnvironmentEntries @([pscustomobject]@{Key='DOTNET_STARTUP_HOOKS';Value='synthetic.dll'}) } 'runtime injection refused'
    $outside = Join-Path $root 'outside.txt'
    [IO.File]::WriteAllText($outside, 'external synthetic')
    Lock-File $outside
    $alias = Join-Path $install 'logs\linked.txt'
    New-Item -ItemType HardLink -Path $alias -Target $outside | Out-Null
    Must-Fail { Check-Tree $install } 'hardlink alias outside protected tree refused'
    Remove-Item -LiteralPath $alias -Force
    foreach ($stage in @('stop','mode','start','')) {
        Fixture
        $script:failStage = $stage
        if ($stage -eq '') { $script:journalLock = [IO.FileStream]::new((Join-Path $install 'office-enrollment.json.device'),
            [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
        $errorText = ''
        try { Invoke-Recovery $package $backup | Out-Null }
        catch { $errorText = $_.Exception.Message }
        Write-Output "STAGE $stage : $errorText"
        if ($stage -eq 'start') {
            Pass ($errorText -match 'Poststart failure' -and $script:mode -eq 'Disabled' -and $script:state -eq 'Stopped') 'ambiguous start leaves replacement disabled and stopped'
            Pass (([IO.File]::ReadAllText((Join-Path $install 'office-enrollment.json.device'))) -like '*synthetic-id*') 'poststart journal not overwritten'
        } elseif ($stage) {
            Pass ($errorText -match 'Recovery failed before start' -and $script:state -eq 'Running') "prestart $stage restores original running service"
            Pass (([IO.File]::ReadAllText((Join-Path $install 'CabinetPlatform.Agent.exe'))) -eq 'old-binary') "prestart $stage restores original binary"
        } else {
            Pass (!$errorText -and $script:state -eq 'Running' -and $script:mode -eq 'Auto') 'replacement starts and becomes automatic'
            Pass ($script:restoredAtStart -and $script:events[-2] -eq 'start') 'identity restored before first service start'
            Pass (([IO.File]::ReadAllText((Join-Path $install 'buffer\pending.txt'))) -eq 'pending') 'pending state restored before start'
            Pass (([IO.File]::ReadAllText((Join-Path $install 'buffer\CabinetPlatform.Agent.exe'))) -eq 'nested pending') 'nested filename collision retained'
            Pass (@(Get-ChildItem -LiteralPath $install -Recurse -Filter '*.device' -File).Count -eq 1 -and
                ([IO.File]::ReadAllText((Join-Path $install 'state\agent-state.json'))) -like '*synthetic-cabinet*') 'one original device identity retained'
            Pass (($script:events -join ',') -match 'mode-demand,start,mode-auto$' -and 'delete' -notin $script:events -and 'create' -notin $script:events) 'existing registration retained during upgrade'
        }
        $runs = @(Get-ChildItem -LiteralPath $backup -Directory)
        $snapshots = @(Get-ChildItem -LiteralPath $backup -Recurse -Directory | Where-Object Name -eq 'original-copy')
        if ($stage -eq 'stop') { Pass ($runs.Count -gt 0) 'stop failure retains private recovery directory' }
        else { Pass ($runs.Count -gt 0 -and $snapshots.Count -ge 1) "protected original retained at $stage" }
    }
    # A package drift must fail before service control, using the immutable stream.
    $zip = Join-Path $root 'synthetic.zip'
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.FileStream]::new($zip,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $archive = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
        try {
            $entry = $archive.CreateEntry('CabinetPlatform.Agent.exe')
            $writer = [IO.StreamWriter]::new($entry.Open()); try { $writer.Write('synthetic') } finally { $writer.Dispose() }
        } finally { $archive.Dispose() }
    } finally { $stream.Dispose() }
    $read = [IO.FileStream]::new($zip,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try { Must-Fail { Load-Package $read ('0' * 64) ('a' * 40) } 'package drift rejected before service changes' }
    finally { $read.Dispose() }
    # The package validator also accepts a complete, internally inventoried stream.
    $validZip = Join-Path $root 'valid.zip'
    $configBytes = [Text.Encoding]::UTF8.GetBytes($script:syntheticConfig)
    $exeBytes = [Text.Encoding]::UTF8.GetBytes('synthetic-executable')
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $inventory = @{ 'CabinetPlatform.Agent.exe' = [BitConverter]::ToString($sha.ComputeHash($exeBytes)).Replace('-','');
            'appsettings.json' = [BitConverter]::ToString($sha.ComputeHash($configBytes)).Replace('-','') }
    } finally { $sha.Dispose() }
    $manifestBytes = [Text.Encoding]::UTF8.GetBytes((@{schema=1; component='agent'; endpoint=$endpoint;
        sourceCommit=('a' * 40); signed=$false; sha256=$inventory} | ConvertTo-Json -Depth 10))
    $write = [IO.FileStream]::new($validZip,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $archive = [IO.Compression.ZipArchive]::new($write,[IO.Compression.ZipArchiveMode]::Create,$true)
        try {
            foreach ($pair in @(@('CabinetPlatform.Agent.exe',$exeBytes),@('appsettings.json',$configBytes),@('kit-manifest.json',$manifestBytes))) {
                $entry = $archive.CreateEntry($pair[0]); $member = $entry.Open()
                try { $bytes = [byte[]]$pair[1]; $member.Write($bytes,0,$bytes.Length) } finally { $member.Dispose() }
            }
        } finally { $archive.Dispose() }
    } finally { $write.Dispose() }
    $digest = (Get-FileHash -LiteralPath $validZip -Algorithm SHA256).Hash
    $read = [IO.FileStream]::new($validZip,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $validated = Load-Package $read $digest ('a' * 40)
        Pass ($validated.Count -eq 3 -and $validated.ContainsKey('cabinetplatform.agent.exe')) 'complete immutable package stream accepted'
    } finally { $read.Dispose() }
    # SID based ACL inspection handles unresolved account names without translation.
    $extra = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-111111111-222222222-333333333-1001')
    $acl = Get-Acl -LiteralPath $backup
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($extra,[Security.AccessControl.FileSystemRights]::WriteData,[Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $backup -AclObject $acl
    Must-Fail { Check-Acl $backup $true } 'unmapped writable SID refused'
    Write-Output "Native checks=$script:checks; synthetic service only"
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

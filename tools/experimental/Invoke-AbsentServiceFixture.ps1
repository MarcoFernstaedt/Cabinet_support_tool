# NONSHIPPING / NO_GO. Disposable Windows file-transaction rehearsal ONLY.
# No SCM calls, service start, server access, enrollment, key generation or live install path.
[CmdletBinding()]
param(
    [string]$FixtureRoot, [string]$OriginalCopy, [string]$OriginalInstalled,
    [string]$Candidate, [string]$Attestation, [string]$WorkRoot,
    [switch]$FixtureOnly, [switch]$InjectAfterCopy
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Refuse { throw 'NO_GO: fixture admission or transaction failed; preserve originals.' }
function Canonical([string]$path) {
    if (!$path -or ![IO.Path]::IsPathRooted($path) -or $path.StartsWith('\\')) { Refuse }
    $full = [IO.Path]::GetFullPath($path).TrimEnd('\')
    if ($full -match '^(?i:[a-z]:\\(?:Program Files|Windows)(?:\\|$))') { Refuse }
    $part = $full
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse }
        }
        $parent = [IO.Path]::GetDirectoryName($part)
        if (!$parent -or $parent -eq $part) { break }
        $part = $parent
    }
    return $full
}
function Hash([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
function GuardAcl([string]$path) {
    $acl = Get-Acl -LiteralPath $path
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $safe = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $safe) { Refuse }
    foreach ($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $ace.IdentityReference.Value -notin $safe -and
            ($ace.FileSystemRights -band ([Security.AccessControl.FileSystemRights]::Write -bor
                [Security.AccessControl.FileSystemRights]::Delete -bor
                [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
                [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
                [Security.AccessControl.FileSystemRights]::TakeOwnership)) -ne 0) { Refuse }
    }
}
function GuardTree([string]$root) {
    if (!(Test-Path -LiteralPath $root -PathType Container)) { Refuse }
    $queue = [Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($root)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse }
        GuardAcl $current
        foreach ($child in Get-ChildItem -LiteralPath $current -Force) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse }
            GuardAcl $child.FullName
            if ($child.PSIsContainer) { $queue.Enqueue($child.FullName) }
        }
    }
}
function SecureDirectory([string]$path) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = Get-Acl -LiteralPath $path
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($id in @($sid,'S-1-5-18','S-1-5-32-544')) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($id),
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
    GuardAcl $path
}
function RequireDigest($value) { if ($value -isnot [string] -or $value -cnotmatch '^[A-Fa-f0-9]{64}$') { Refuse } }
try {
    if (!$FixtureOnly -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Refuse }
    $root = Canonical $FixtureRoot
    $temp = Canonical $env:TEMP
    if (!$root.StartsWith($temp + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $root -notmatch '(?i)\\cabinet-absent-fixture-[0-9a-f]{32}$') { Refuse }
    $one = Canonical $OriginalCopy; $two = Canonical $OriginalInstalled
    $candidatePath = Canonical $Candidate; $attPath = Canonical $Attestation; $work = Canonical $WorkRoot
    if ($one -ine (Join-Path $root 'one') -or $two -ine (Join-Path $root 'two') -or
        $candidatePath -ine (Join-Path $root 'candidate.exe') -or
        $attPath -ine (Join-Path $root 'attestation.json') -or $work -ine (Join-Path $root 'work')) { Refuse }
    if ((Get-CimInstance Win32_Service -Filter "Name='CabinetPlatformAgent'") -or
        (Test-Path -LiteralPath 'C:\Program Files\Mashura\CabinetAgent')) { Refuse }
    foreach ($p in @($root,$one,$two,$work)) { GuardTree $p }
    foreach ($p in @($candidatePath,$attPath)) { if (!(Test-Path -LiteralPath $p -PathType Leaf)) { Refuse }; GuardAcl $p }
    $att = Get-Content -LiteralPath $attPath -Raw | ConvertFrom-Json
    if ($att.schema -ne 1 -or $att.fixture -cne $true -or
        $att.originalIdentityAttested -cne $true -or $att.originalServiceDefinitionAttested -cne $true -or
        $att.sourceBound -cne $true -or $att.serverRevisionAttested -cne $true -or
        $att.journalNotAdvancedAttested -cne $true -or
        $att.sourceCommit -cnotmatch '^[a-f0-9]{40}$' -or
        $att.package.sourceCommit -cne $att.sourceCommit -or
        !$att.serverRevision -or $att.package.serverRevision -cne $att.serverRevision) { Refuse }
    $svc = $att.originalServiceDefinition
    if (!$svc -or $svc.name -cne 'CabinetPlatformAgent' -or $svc.account -cne 'LocalSystem' -or
        $svc.image -cne 'CabinetPlatform.Agent.exe' -or $svc.start -cne 'disabled' -or
        $svc.type -cne 'own' -or $null -eq $svc.dependencies -or
        !$svc.failureActions -or !$svc.securityDescriptor -or !$svc.preshutdownMilliseconds) { Refuse }
    $members = @('office-enrollment.json.device','state/agent-state.json','appsettings.json')
    if (@($att.files.PSObject.Properties).Count -ne $members.Count -or
        @($att.package.files.PSObject.Properties).Count -ne 1) { Refuse }
    foreach ($member in $members) {
        $property = $att.files.PSObject.Properties[$member]
        if (!$property) { Refuse }
        RequireDigest $property.Value
        $relative = $member.Replace('/','\')
        $a = Join-Path $one $relative; $b = Join-Path $two $relative
        foreach ($p in @($a,$b)) {
            if (!(Test-Path -LiteralPath $p -PathType Leaf) -or (Hash $p) -cne $property.Value.ToUpperInvariant()) { Refuse }
        }
        $left = [IO.File]::ReadAllBytes($a); $right = [IO.File]::ReadAllBytes($b)
        if ($left.Length -ne $right.Length) { Refuse }
        for ($i = 0; $i -lt $left.Length; $i++) { if ($left[$i] -ne $right[$i]) { Refuse } }
    }
    foreach ($copy in @($one,$two)) {
        $actual = @(Get-ChildItem -LiteralPath $copy -Recurse -Force -File | ForEach-Object { $_.FullName.Substring($copy.Length + 1).Replace('\','/') })
        if ($actual.Count -ne $members.Count) { Refuse }
        foreach ($name in $actual) { if ($name -cnotin $members) { Refuse } }
    }
    $binary = $att.package.files.PSObject.Properties['CabinetPlatform.Agent.exe']
    if (!$binary -or $binary.Name -cne 'CabinetPlatform.Agent.exe') { Refuse }
    RequireDigest $binary.Value
    if ((Hash $candidatePath) -cne $binary.Value.ToUpperInvariant()) { Refuse }
    if (@(Get-ChildItem -LiteralPath $work -Force).Count -ne 0) { Refuse }
    $stage = Join-Path $work 'stage'; $install = Join-Path $work 'install'
    New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
    SecureDirectory $stage
    try {
        foreach ($member in $members) {
            $relative = $member.Replace('/','\'); $target = Join-Path $stage $relative
            $parent = Split-Path $target
            if (!(Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null; SecureDirectory $parent }
            [IO.File]::WriteAllBytes($target,[IO.File]::ReadAllBytes((Join-Path $one $relative)))
            if ((Hash $target) -cne $att.files.PSObject.Properties[$member].Value.ToUpperInvariant()) { Refuse }
        }
        if ($InjectAfterCopy) { Refuse }
        [IO.File]::WriteAllBytes((Join-Path $stage 'CabinetPlatform.Agent.exe'),[IO.File]::ReadAllBytes($candidatePath))
        if ((Hash (Join-Path $stage 'CabinetPlatform.Agent.exe')) -cne $binary.Value.ToUpperInvariant()) { Refuse }
        GuardTree $stage
        if (Test-Path -LiteralPath $install) { Refuse }
        [IO.Directory]::Move($stage,$install)
        GuardTree $install
        Write-Output 'FIXTURE_STAGED_NO_SERVICE_START'
    } catch {
        # Never touch original copies. A failed staged tree is retained for reconciliation.
        Refuse
    }
} catch { Refuse }

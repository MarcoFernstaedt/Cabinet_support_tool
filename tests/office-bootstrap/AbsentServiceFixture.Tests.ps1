# Disposable native Windows file-transaction fixture; NEVER targets a real installation.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$helper = Join-Path $PSScriptRoot '../../tools/experimental/Invoke-AbsentServiceFixture.ps1'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'BLOCKED: native Windows required' }
$root = Join-Path $env:TEMP ('cabinet-absent-fixture-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
$pass = 0
function Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
function Setup {
    $case = Join-Path $root ('cabinet-absent-fixture-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $case | Out-Null
    foreach ($name in @('one','two','work')) { New-Item -ItemType Directory (Join-Path $case $name) | Out-Null }
    $files = @{'office-enrollment.json.device'='fixture-not-a-real-key'; 'state/agent-state.json'='fixture-state'; 'appsettings.json'='fixture-config'}
    $digests = @{}
    foreach ($name in $files.Keys) {
        foreach ($copy in @('one','two')) {
            $path = Join-Path (Join-Path $case $copy) $name
            New-Item -ItemType Directory (Split-Path $path) -Force | Out-Null
            [IO.File]::WriteAllText($path, $files[$name])
        }
        $digests[$name] = Sha (Join-Path (Join-Path $case 'one') $name)
    }
    [IO.File]::WriteAllText((Join-Path $case 'candidate.exe'),'fixture-binary')
    $candidate = Sha (Join-Path $case 'candidate.exe')
    $att = @{
        schema=1; fixture=$true; originalIdentityAttested=$true; originalServiceDefinitionAttested=$true
        sourceBound=$true; serverRevisionAttested=$true; journalNotAdvancedAttested=$true
        originalServiceDefinition=@{ name='CabinetPlatformAgent'; account='LocalSystem'; image='CabinetPlatform.Agent.exe'; start='disabled'; type='own'; dependencies=@(); failureActions='fixture-reviewed'; securityDescriptor='fixture-reviewed'; preshutdownMilliseconds=180000 }
        serverRevision='fixture-revision'; sourceCommit=('a' * 40); package=@{ sourceCommit=('a' * 40); serverRevision='fixture-revision'; files=@{'CabinetPlatform.Agent.exe'=$candidate} }
        files=$digests
    }
    $attPath = Join-Path $case 'attestation.json'
    $att | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $attPath -Encoding UTF8
    return @{ dir=$case; att=$att; attPath=$attPath }
}
function Run($c) {
    & $helper -FixtureRoot $c.dir -OriginalCopy (Join-Path $c.dir 'one') -OriginalInstalled (Join-Path $c.dir 'two') -Candidate (Join-Path $c.dir 'candidate.exe') -Attestation $c.attPath -WorkRoot (Join-Path $c.dir 'work') -FixtureOnly
}
function ExpectFailure([string]$name, [scriptblock]$mutate) {
    $c = Setup; & $mutate $c
    $failed = $false
    try { Run $c | Out-Null } catch { $failed = $true }
    if (!$failed) { throw "FAIL: $name accepted" }
    $installed = Join-Path $c.dir 'work/install'
    if ($name -eq 'partial-install-exists') {
        if (!(Test-Path -LiteralPath $installed -PathType Container) -or
            @(Get-ChildItem -LiteralPath $installed -Force).Count -ne 0) { throw "FAIL: $name altered preexisting install" }
    } elseif (Test-Path -LiteralPath $installed) { throw "FAIL: $name installed" }
    $script:pass++; Write-Output "PASS $name"
}
try {
    $c=Setup
    Run $c | Out-Null
    if ((Sha (Join-Path $c.dir 'work/install/office-enrollment.json.device')) -cne $c.att.files['office-enrollment.json.device']) { throw 'FAIL: identity bytes changed' }
    if ((Sha (Join-Path $c.dir 'work/install/CabinetPlatform.Agent.exe')) -cne $c.att.package.files['CabinetPlatform.Agent.exe']) { throw 'FAIL: candidate bytes changed' }
    $pass++; Write-Output 'PASS fixture-stage-preserves-original'
    ExpectFailure 'missing-identity-attestation' { param($c) $c.att.originalIdentityAttested=$false; $c.att | ConvertTo-Json -Depth 12 | Set-Content $c.attPath }
    ExpectFailure 'missing-service-definition' { param($c) $c.att.originalServiceDefinitionAttested=$false; $c.att | ConvertTo-Json -Depth 12 | Set-Content $c.attPath }
    ExpectFailure 'server-revision-mismatch' { param($c) $c.att.package.serverRevision='wrong'; $c.att | ConvertTo-Json -Depth 12 | Set-Content $c.attPath }
    ExpectFailure 'backup-byte-mismatch' { param($c) [IO.File]::WriteAllText((Join-Path $c.dir 'two/office-enrollment.json.device'),'different') }
    ExpectFailure 'candidate-hash-mismatch' { param($c) [IO.File]::WriteAllText((Join-Path $c.dir 'candidate.exe'),'different') }
    ExpectFailure 'journal-advanced' { param($c) $c.att.journalNotAdvancedAttested=$false; $c.att | ConvertTo-Json -Depth 12 | Set-Content $c.attPath }
    ExpectFailure 'source-commit-mismatch' { param($c) $c.att.package.sourceCommit=('b' * 40); $c.att | ConvertTo-Json -Depth 12 | Set-Content $c.attPath }
    $c=Setup
    $failed=$false
    try { & $helper -FixtureRoot $c.dir -OriginalCopy (Join-Path $c.dir 'one') -OriginalInstalled (Join-Path $c.dir 'two') -Candidate (Join-Path $c.dir 'candidate.exe') -Attestation $c.attPath -WorkRoot (Join-Path $c.dir 'work') -FixtureOnly -InjectAfterCopy | Out-Null } catch { $failed=$true }
    if (!$failed -or (Test-Path (Join-Path $c.dir 'work/install')) -or !(Test-Path (Join-Path $c.dir 'one/office-enrollment.json.device'))) { throw 'FAIL: interrupted copy not retained safely' }
    $pass++; Write-Output 'PASS interrupted-copy-retains-original'
    ExpectFailure 'partial-install-exists' { param($c) New-Item -ItemType Directory (Join-Path $c.dir 'work/install') | Out-Null }
    ExpectFailure 'reparse-backup' { param($c) Move-Item (Join-Path $c.dir 'one') (Join-Path $c.dir 'hidden'); New-Item -ItemType Junction -Path (Join-Path $c.dir 'one') -Target (Join-Path $c.dir 'hidden') | Out-Null }
    $c=Setup; $failed=$false
    try { & $helper -FixtureRoot $c.dir -OriginalCopy (Join-Path $c.dir 'one') -OriginalInstalled (Join-Path $c.dir 'two') -Candidate (Join-Path $c.dir 'candidate.exe') -Attestation $c.attPath -WorkRoot (Join-Path $c.dir 'work') | Out-Null } catch { $failed=$true }
    if (!$failed -or (Test-Path -LiteralPath (Join-Path $c.dir 'work/install'))) { throw 'FAIL: omitted-fixture-only accepted' }
    $pass++; Write-Output 'PASS omitted-fixture-only'
    $c=Setup; $failed=$false
    try { & $helper -FixtureRoot $c.dir -OriginalCopy (Join-Path $c.dir 'two') -OriginalInstalled (Join-Path $c.dir 'two') -Candidate (Join-Path $c.dir 'candidate.exe') -Attestation $c.attPath -WorkRoot (Join-Path $c.dir 'work') -FixtureOnly | Out-Null } catch { $failed=$true }
    if (!$failed -or (Test-Path -LiteralPath (Join-Path $c.dir 'work/install'))) { throw 'FAIL: path-substitution accepted' }
    $pass++; Write-Output 'PASS path-substitution'
    Write-Output "RESULT $pass fixture cases passed (file staging only; SCM not exercised)"
} finally { Write-Output 'FIXTURE_RETAINED_FOR_MANUAL_REVIEW' }

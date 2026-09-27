# Run only on an authorized disposable Windows 10/11 lab machine from an elevated 5.1 shell.
$ErrorActionPreference = 'Stop'
$helper = (Resolve-Path (Join-Path $PSScriptRoot '..\..\tools\Install-CabinetDemoAgent.ps1')).Path
$tokens = $null
$errors = $null
[Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -ne 0) { throw "Parser refused helper: $($errors[0])" }
$target = 'C:\Program Files\Mashura\CabinetAgent'
if ((Test-Path -LiteralPath $target) -or (Get-Service -Name CabinetPlatformAgent -ErrorAction SilentlyContinue)) {
    throw 'Not a fresh disposable lab machine. No installer was invoked.'
}
$folder = Join-Path $env:TEMP ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $folder | Out-Null
try {
    $zip = Join-Path $folder 'inert.zip'
    $token = Join-Path $folder 'inert.json'
    [IO.File]::WriteAllBytes($zip, [byte[]](1, 2, 3))
    [IO.File]::WriteAllBytes($token, [byte[]](123, 125))
    $refused = $false
    try {
        & $helper -AgentZip $zip -EnrollmentFile $token -ExpectedSha256 ('0' * 64) -ExpectedSourceCommit ('a' * 40)
    } catch {
        $refused = $_.Exception.Message -like '*Package digest differs*'
    }
    if (!$refused) { throw 'Expected wrong-digest refusal before any write.' }
    if ((Test-Path -LiteralPath $target) -or (Get-Service -Name CabinetPlatformAgent -ErrorAction SilentlyContinue)) {
        throw 'Unexpected installation side effect.'
    }
    Write-Output 'PASS: PowerShell parser and wrong-digest refusal without install side effects.'
} finally {
    Remove-Item -LiteralPath $folder -Recurse -Force
}

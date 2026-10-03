#Requires -Version 5.1
# Native synthetic-only fixture. Never recurse, overwrite, or touch real Agent state.
$ErrorActionPreference='Stop'
$helper=Join-Path $PSScriptRoot 'Prepare-FreshAgentStateRoot.ps1'
$prefix='C:\Program Files\CabinetAgent-Fresh-'
function Invoke-Preparation($id, $expectSuccess) {
    $oldPreference=$ErrorActionPreference
    $ErrorActionPreference='Continue'
    try { $output=& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Id $id 2>&1; $exit=$LASTEXITCODE }
    finally { $ErrorActionPreference=$oldPreference }
    if ($expectSuccess -and ($exit -ne 0 -or "$output" -ne ($prefix+$id))) { throw "expected fresh success: $output" }
    if (!$expectSuccess -and ($exit -eq 0 -or "$output" -notmatch 'Refusing\s+existing\s+state\s+root')) { throw "wrong collision refusal: $output" }
    "case=$id expectedSuccess=$expectSuccess exit=$exit"
}
function Remove-ExactEmpty($path) {
    if (!$path.StartsWith($prefix, [StringComparison]::Ordinal) -or
        !(Test-Path -LiteralPath $path -PathType Container) -or
        ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        @((Get-ChildItem -LiteralPath $path -Force)).Count -ne 0) { throw "unsafe cleanup refused: $path" }
    [IO.Directory]::Delete($path, $false)
    if (Test-Path -LiteralPath $path) { throw "cleanup readback failed" }
}
$id=[guid]::NewGuid().ToString('D')
$path=$prefix+$id
try {
    Invoke-Preparation $id $true
    Invoke-Preparation $id $false
    Invoke-Preparation $id $false
    $acl=Get-Acl -LiteralPath $path
    if ($acl.Sddl -ne 'O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)') { throw "unexpected ACL: $($acl.Sddl)" }
    "readback=$($acl.Sddl) empty=$(@(Get-ChildItem -LiteralPath $path -Force).Count -eq 0)"
} finally { if (Test-Path -LiteralPath $path) { Remove-ExactEmpty $path } }
$fileId=[guid]::NewGuid().ToString('D'); $filePath=$prefix+$fileId
try {
    [IO.File]::WriteAllText($filePath,'synthetic collision')
    Invoke-Preparation $fileId $false
} finally { if ([IO.File]::Exists($filePath)) { [IO.File]::Delete($filePath) } }
$linkId=[guid]::NewGuid().ToString('D'); $linkPath=$prefix+$linkId
try {
    $result=& cmd.exe /d /c "mklink /J `"$linkPath`" `"C:\Windows`"" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "junction setup failed: $result" }
    Invoke-Preparation $linkId $false
    Invoke-Preparation $linkId $false
} finally {
    if ([IO.Directory]::Exists($linkPath) -and ((Get-Item -LiteralPath $linkPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        $result=& cmd.exe /d /c "rmdir `"$linkPath`"" 2>&1
        if ($LASTEXITCODE -ne 0) { throw "junction cleanup failed: $result" }
    }
}
"native-fixture=PASS"

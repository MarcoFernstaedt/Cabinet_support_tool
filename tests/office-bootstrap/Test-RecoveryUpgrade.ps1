$ErrorActionPreference='Stop'
# Reuse the established synthetic fixtures, replacing only their scenario runner.
$text=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Test-RecoveryAtomicity.ps1') -Raw
$prefix=$text.Substring(0,$text.IndexOf("try {`n foreach("))
. ([scriptblock]::Create($prefix.Replace("$"+'PSScriptRoot',("'"+$PSScriptRoot+"'"))))
try {
 Fixture
 Invoke-Recovery $package $backup | Out-Null
 Check ($script:deletes -eq 0 -and $script:exists -and $script:state -eq 'Running') 'upgrade retains service registration'
 Check ([IO.File]::ReadAllText((Join-Path $install 'CabinetPlatform.Agent.exe')) -eq 'new') 'upgrade installs replacement'
 Write-Output "UPGRADE_CHECKS=$script:checks"
}finally{Remove-Item -LiteralPath $root -Recurse -Force}

<#
.SYNOPSIS
  Builds the two agent services, the harness and the updater as self-contained win-x64 programs.
.DESCRIPTION
  Release builds for cabinets come only from the build pipeline
  (docs/spec/02-security-model.md). Use this script for a test machine.
#>
[CmdletBinding()]
param(
    [string] $Output = (Join-Path $PSScriptRoot '..\out'),
    # The version every program reports (release builds come from the pipeline, which sets it).
    [string] $Version,
    # A test build only: an upgrade trust folder from New-UpgradeTrust.ps1 (a throwaway release key and test code-signing root).
    [string] $UpgradeTrustDir
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$dotnet = (Get-Command dotnet -CommandType Application).Source

$extra = @()
if ($Version) { $extra += "-p:Version=$Version" }
if ($UpgradeTrustDir) {
    Write-Warning "Test build: this agent accepts only releases signed with the key in $UpgradeTrustDir."
    $extra += "-p:UpgradeTrustDir=$((Resolve-Path $UpgradeTrustDir).Path)"
}
foreach ($project in 'Cabinet.Agent.Broker', 'Cabinet.Agent.Network', 'Cabinet.Agent.Harness', 'Cabinet.Agent.Updater') {
    $target = Join-Path $Output $project
    # The committed lock files pin the win-x64 runtime packs too (agent/Directory.Build.props), so the restore is locked: the published
    # programs are built from exactly the reviewed, signed packages (agent/nuget.config).
    & $dotnet @('restore', (Join-Path $root "src\$project\$project.csproj"), '--runtime', 'win-x64', '--locked-mode')
    if ($LASTEXITCODE -ne 0) { throw "Restoring $project failed (a lock file is out of date?)." }
    & $dotnet @('publish', (Join-Path $root "src\$project\$project.csproj"), '--no-restore', '--configuration', 'Release',
        '--runtime', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '--output', $target) @extra
    if ($LASTEXITCODE -ne 0) { throw "Publishing $project failed." }
}
Write-Host "Published to $Output"

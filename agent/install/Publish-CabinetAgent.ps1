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
    & $dotnet @('publish', (Join-Path $root "src\$project\$project.csproj"), '--configuration', 'Release',
        '--runtime', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '--output', $target,
        # Publishing adds the win-x64 runtime and its build tasks, which the committed build-and-test lock files do not
        # list, so publishing keeps its own lock file under obj\ and leaves the committed ones untouched. Every package
        # reference names its exact version and NuGet takes the lowest match, so it resolves the same versions.
        '-p:NuGetLockFilePath=obj\publish.packages.lock.json', '-p:RestoreLockedMode=false') @extra
    if ($LASTEXITCODE -ne 0) { throw "Publishing $project failed." }
}
Write-Host "Published to $Output"

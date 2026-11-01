<#
.SYNOPSIS
  Builds the two agent services, the harness and the updater as self-contained programs for one Windows architecture (-Architecture, win-x64 by default).
.DESCRIPTION
  Release builds for cabinets come only from the build pipeline
  (docs/spec/02-security-model.md). Use this script for a test machine.
#>
[CmdletBinding()]
param(
    [string] $Output,
    # The version every program reports (release builds come from the pipeline, which sets it).
    [string] $Version,
    # Which Windows architecture to publish for. A 32-bit cabinet needs the win-x86 programs; everything else is win-x64.
    [ValidateSet('win-x64', 'win-x86')]
    [string] $Architecture = 'win-x64',
    # A test build only: an upgrade trust folder from New-UpgradeTrust.ps1 (a throwaway release key and test code-signing root).
    [string] $UpgradeTrustDir
)
$ErrorActionPreference = 'Stop'
# Resolved in the body rather than in the parameter default: Windows PowerShell 5.1 binds the default before the
# script's own scope exists, so a -Output default built from $PSScriptRoot is empty under -File.
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
if (-not $Output) { $Output = Join-Path $here '..\out' }
$root = Resolve-Path (Join-Path $here '..')
$dotnet = (Get-Command dotnet -CommandType Application).Source

$extra = @()
if ($Version) { $extra += "-p:Version=$Version" }
if ($UpgradeTrustDir) {
    Write-Warning "Test build: this agent accepts only releases signed with the key in $UpgradeTrustDir."
    $extra += "-p:UpgradeTrustDir=$((Resolve-Path $UpgradeTrustDir).Path)"
}
foreach ($project in 'Cabinet.Agent.Broker', 'Cabinet.Agent.Network', 'Cabinet.Agent.Harness', 'Cabinet.Agent.Updater') {
    # One folder per program, named for the program: the layout Install-CabinetAgent.ps1 (its -SourceDir), New-AgentRelease.ps1
    # (its -PublishDir) and the updater read. Keep two architectures apart with -Output (for example ..\out\win-x86); both
    # the installer and New-AgentRelease.ps1 read each program's PE machine, so a folder of the wrong one is refused.
    $target = Join-Path $Output $project
    # The committed lock files pin the runtime packs of both architectures (agent/Directory.Build.props), so the restore is
    # locked: the published programs are built from exactly the reviewed, signed packages (agent/nuget.config).
    # No --runtime here: it narrows the project's runtime identifiers to the one asked for, which a lock file listing both
    # then refuses (NU1004). The graph RuntimeIdentifiers produces already carries both, and publish picks its own.
    & $dotnet @('restore', (Join-Path $root "src\$project\$project.csproj"), '--locked-mode')
    if ($LASTEXITCODE -ne 0) { throw "Restoring $project failed (a lock file is out of date?)." }
    & $dotnet @('publish', (Join-Path $root "src\$project\$project.csproj"), '--no-restore', '--configuration', 'Release',
        '--runtime', $Architecture, '--self-contained', 'true', '-p:PublishSingleFile=true', '--output', $target) @extra
    if ($LASTEXITCODE -ne 0) { throw "Publishing $project for $Architecture failed." }
}
Write-Host "Published $Architecture to $Output"

<#
.SYNOPSIS
  Builds the two agent services and the harness as self-contained win-x64 programs.
.DESCRIPTION
  Release builds for cabinets come only from the build pipeline
  (docs/spec/02-security-model.md). Use this script for a test machine.
#>
[CmdletBinding()]
param(
    [string] $Output = (Join-Path $PSScriptRoot '..\out')
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$dotnet = (Get-Command dotnet -CommandType Application).Source

foreach ($project in 'Cabinet.Agent.Broker', 'Cabinet.Agent.Network', 'Cabinet.Agent.Harness') {
    $target = Join-Path $Output $project
    & $dotnet @('publish', (Join-Path $root "src\$project\$project.csproj"), '--configuration', 'Release',
        '--runtime', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '--output', $target)
    if ($LASTEXITCODE -ne 0) { throw "Publishing $project failed." }
}
Write-Host "Published to $Output"

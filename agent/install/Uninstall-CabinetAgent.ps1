<#
.SYNOPSIS
  Stops and removes the cabinet agent's services. Keeps C:\ProgramData\Mashura\CabinetAgent unless -RemoveData is given.
#>
[CmdletBinding()]
param([switch] $RemoveData)
$ErrorActionPreference = 'Stop'
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'
foreach ($name in 'CabinetAgentNetwork', 'CabinetAgentBroker') {
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
        Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
        & $sc @('delete', $name) | Out-Null
    }
}
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:ProgramFiles 'Mashura\CabinetAgent')
if ($RemoveData) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:ProgramData 'Mashura\CabinetAgent') }
Write-Host 'Cabinet agent removed.'

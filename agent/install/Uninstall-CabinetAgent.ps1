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
# The version an upgrade kept as its backup.
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:ProgramFiles 'Mashura\CabinetAgent.previous')
if ($RemoveData) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:ProgramData 'Mashura\CabinetAgent')
    # The cabinet's private key, in the machine key store. Without it the old certificate is useless.
    $provider = [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
    if ([Security.Cryptography.CngKey]::Exists('Mashura.CabinetAgent', $provider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey)) {
        [Security.Cryptography.CngKey]::Open('Mashura.CabinetAgent', $provider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey).Delete()
    }
}
Write-Host 'Cabinet agent removed.'

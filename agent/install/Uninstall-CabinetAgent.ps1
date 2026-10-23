<#
.SYNOPSIS
  Stops and removes the cabinet agent's services. Keeps C:\ProgramData\Mashura\CabinetAgent unless -RemoveData is given.
#>
[CmdletBinding()]
param([switch] $RemoveData)
$ErrorActionPreference = 'Stop'
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'

function Invoke-Sc([string[]] $Arguments) {
    # sc.exe says why on standard error; keep it for the failure line. $ErrorActionPreference is relaxed around the call
    # because Windows PowerShell 5.1 turns a native command's standard-error output into a terminating error while 'Stop'.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $sc @Arguments 2>&1 | Out-String
    $ErrorActionPreference = $previous
    return @{ ExitCode = $LASTEXITCODE; Output = (($output -replace '\s+', ' ').Trim()) }
}

function Remove-Path([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Remove-Item -Recurse -Force -LiteralPath $Path
    # This script says the agent was removed, so a file still there (in use, or owned by someone else) is a failure to
    # report, not a warning to swallow.
    if (Test-Path -LiteralPath $Path) { throw "$Path could not be removed. Stop whatever is using it (a service, an open log file) and run again." }
}

# One failure funnel, the same shape as the installer's: what happened, and what to do about it -  never a stack trace.
try {
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from an elevated PowerShell: right-click Windows PowerShell (or PowerShell 7) and choose Run as administrator, then run the same command again.' }

foreach ($name in 'CabinetAgentNetwork', 'CabinetAgentBroker') {
    if (-not (Get-Service -Name $name -ErrorAction SilentlyContinue)) { continue }
    # A service that will not stop is not fatal here: sc.exe delete marks it for deletion either way.
    Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
    $deleted = Invoke-Sc @('delete', $name)
    if ($deleted.ExitCode -ne 0) {
        throw "The $name service could not be deleted (sc.exe exit code $($deleted.ExitCode)): $($deleted.Output) Run this from an elevated PowerShell; if it keeps failing, the service is still registered and the agent is still installed."
    }
}
Remove-Path (Join-Path $env:ProgramFiles 'Mashura\CabinetAgent')
# The version an upgrade kept as its backup.
Remove-Path (Join-Path $env:ProgramFiles 'Mashura\CabinetAgent.previous')
if ($RemoveData) {
    # The data goes first: the key is the only thing that makes the old certificate useless, so it is deleted only once
    # the data that belongs with it has really gone.
    Remove-Path (Join-Path $env:ProgramData 'Mashura\CabinetAgent')
    # The cabinet's private key, in the machine key store. Without it the old certificate is useless.
    $provider = [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
    if ([Security.Cryptography.CngKey]::Exists('Mashura.CabinetAgent', $provider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey)) {
        [Security.Cryptography.CngKey]::Open('Mashura.CabinetAgent', $provider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey).Delete()
        if ([Security.Cryptography.CngKey]::Exists('Mashura.CabinetAgent', $provider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey)) {
            throw 'The cabinet key is still in the machine key store; the data is gone but the key was not deleted.'
        }
    }
}
Write-Host 'Cabinet agent removed.'
if (-not $RemoveData) { Write-Host 'The cabinet key and the data folder were kept, so this cabinet can be installed again with the same identity. Add -RemoveData to take the key out as well.' }
}
catch {
    Write-Host ''
    Write-Host 'The cabinet agent was NOT removed.' -ForegroundColor Red
    Write-Host "  What happened : $($_.Exception.Message)"
    if ($_.InvocationInfo -and $_.InvocationInfo.ScriptLineNumber) { Write-Host "  Script line   : $($_.InvocationInfo.ScriptLineNumber)" }
    Write-Host '  Next step     : close anything using the agent (a PowerShell window in the agent folder, an open log file), then run this script again from an elevated PowerShell.'
    Write-Host ''
    exit 1
}

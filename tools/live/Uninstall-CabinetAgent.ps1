<#
.SYNOPSIS
  Stops and removes the Mashura Cabinet Support Agent service.

.DESCRIPTION
  By default the install folder (logs, local state, buffered telemetry) is kept
  for inspection. Use -RemoveFiles to delete it too, which Install-CabinetAgent.ps1
  needs before a reinstall. The Agent's machine ID comes from the hardware, so a
  reinstall on the same computer is recognised by the Server as the same
  cabinet; retire it in the Console if the computer should stop reporting.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([switch]$RemoveFiles)

$ErrorActionPreference = 'Stop'
$ServiceName = 'CabinetPlatformAgent'
$Install = Join-Path $env:ProgramFiles 'Mashura\CabinetAgent'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Run this from an elevated PowerShell (Run as administrator).' -ForegroundColor Red
    exit 1
}

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    if ($PSCmdlet.ShouldProcess($ServiceName, 'Stop and delete the Windows service')) {
        if ($svc.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force; $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
        & sc.exe delete $ServiceName | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Host 'sc.exe delete failed.' -ForegroundColor Red; exit 1 }
        Write-Host "Removed service $ServiceName (and its stored agent key)."
    }
} else {
    Write-Host "No $ServiceName service is installed."
}

if ($RemoveFiles -and (Test-Path -LiteralPath $Install)) {
    if ($PSCmdlet.ShouldProcess($Install, 'Delete the Agent folder, including its identity state and logs')) {
        Remove-Item -LiteralPath $Install -Recurse -Force
        Write-Host "Deleted $Install."
    }
} elseif (Test-Path -LiteralPath $Install) {
    Write-Host "Kept $Install (logs and local state). To reinstall, run again with -RemoveFiles first;"
    Write-Host "the machine ID comes from the hardware, so the Server still recognises this computer."
}

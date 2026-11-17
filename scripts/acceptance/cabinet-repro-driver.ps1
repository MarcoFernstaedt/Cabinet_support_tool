<#  Runs the session-shell repro on the cabinet with the network state it needs.

  Why a script on the cabinet and not an SSH one-liner: the repro requires the node to be
  down, and taking the node down kills the very SSH session that would be driving it. So
  this runs unattended - queued as a scheduled task before the node goes down - and owns the
  whole cycle: hold the watchdog, run the instrument, restore the node, clear the hold.

  The hold is written with the cabinet's own clock. The host clock on this machine is hours
  behind the platform, and the watchdog compares the stamp against its own clock, so a stamp
  written anywhere else would hold the watchdog off for the size of the skew.
#>
param([int]$TimeoutSeconds = 65, [string]$Log = 'C:\repro\repro-driver.log')
$ErrorActionPreference = 'Continue'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
function Write-Log($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 $Log }
function Get-State { try { (& $ts status --json | ConvertFrom-Json).BackendState } catch { "error: $($_.Exception.Message)" } }

Write-Log "driver start; BackendState=$(Get-State)"
[int][double]::Parse((Get-Date -UFormat %s)) | Out-File -Encoding ascii C:\tailscale-watchdog.hold
Write-Log "hold written with the cabinet clock"
# Own the network state rather than assuming it: run as the signed-in user, down and up
# both work here, and the repro requires the node down. Assuming it was down is what made
# an earlier run stop at its second command with a thrown assertion.
& $ts down
Start-Sleep -Seconds 3
Write-Log "node down; BackendState=$(Get-State)"
try {
  & 'C:\repro\Cabinet.Agent.SessionShellRepro.exe' $TimeoutSeconds *>> $Log
  Write-Log "repro exit code $LASTEXITCODE"
} catch {
  Write-Log "repro threw: $($_.Exception.Message)"
} finally {
  Write-Log "restoring; BackendState=$(Get-State)"
  & $ts up 2>&1 | Out-Null
  Start-Sleep -Seconds 5
  if ((Get-State) -ne 'Running') { Restart-Service Tailscale -Force; Start-Sleep -Seconds 15 }
  $final = Get-State
  Write-Log "restore result: BackendState=$final"
  if ($final -eq 'Running') { Remove-Item C:\tailscale-watchdog.hold -ErrorAction SilentlyContinue; Write-Log 'hold cleared' }
}

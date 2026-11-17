<#  Tailscale restore watchdog for the cabinet. Runs every thirty minutes and at logon.

  Two tasks point at this script: one as SYSTEM, one in the signed-in user's context. Only the
  user-context one can actually bring the node up - `tailscale up` as SYSTEM fails with "the
  target profile does not belong to the user" - which is why the tray Connect button works and
  a service restart alone does not. The SYSTEM task is the backstop for the service.

  The hold file lets a test own the node for a short window without the watchdog fighting it.
  It holds "pid=<pid>;ts=<unix seconds>", written by the process that wants the node down. The
  hold is honoured only while that process is still alive AND the window is younger than
  MaxHoldSeconds. Anything else - a stale hold, a malformed hold, a hold whose owner died or
  stalled - is ignored and the node is restored. That direction matters: a test that dies
  holding the node down must not be able to strand the machine off the tailnet.
#>
param([int]$MaxHoldSeconds = 900, [string]$Log = 'C:\tailscale-watchdog.log')
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
function Write-Log($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 $Log }
function Get-State { try { (& $ts status --json | ConvertFrom-Json).BackendState } catch { "error" } }

$state = Get-State
if ($state -eq 'Running') { Write-Log "ok: BackendState=Running; nothing to do"; exit 0 }

# Honour a hold only while its owner lives and the window is current.
$held = $false
if (Test-Path 'C:\tailscale-watchdog.hold') {
  $raw = (Get-Content 'C:\tailscale-watchdog.hold' -Raw).Trim()
  if ($raw -match '^pid=(\d+);ts=(\d+)$') {
    $heldBy = [int]$Matches[1]; $stamp = [int64]$Matches[2]
    $age = [int64][double]::Parse((Get-Date -UFormat %s)) - $stamp
    $alive = [bool](Get-Process -Id $heldBy -ErrorAction SilentlyContinue)
    if ($alive -and $age -ge 0 -and $age -lt $MaxHoldSeconds) {
      $held = $true
      Write-Log "held: pid $heldBy alive, age ${age}s; leaving the node down"
    } else {
      Write-Log "stale hold ignored (pid $heldBy alive=$alive age=${age}s); restoring"
    }
  } else {
    Write-Log "malformed hold ignored; restoring"
  }
}
if ($held) { exit 0 }

Write-Log "restoring; BackendState=$state"
& $ts up 2>&1 | Out-Null
Start-Sleep -Seconds 5
if ((Get-State) -ne 'Running') { Restart-Service Tailscale -Force; Start-Sleep -Seconds 15 }
$final = Get-State
Write-Log "restore result: BackendState=$final"
if ($final -eq 'Running') { Remove-Item 'C:\tailscale-watchdog.hold' -ErrorAction SilentlyContinue; Write-Log 'hold cleared' }

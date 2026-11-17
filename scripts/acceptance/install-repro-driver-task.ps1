<#  Installs the session-shell repro driver as a user-context scheduled task.

  Detaching with Start-Process over SSH does not survive the SSH session ending, so a driver
  launched that way dies with the connection - and if it had already taken the node down, the
  machine is left off the tailnet until the watchdog's hold expires. A scheduled task is not
  tied to the session, and running it in the signed-in user's context is what makes the
  restore work: `tailscale up` as SYSTEM fails with a profile error.

  Install while the node is up, then `schtasks /run /tn cabinet-repro-driver`. The task takes
  the node down, runs the instrument with the network state it requires, restores the node,
  and clears the hold only once the node is confirmed Running.
#>
$user = "$env:COMPUTERNAME\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\repro\cabinet-repro-driver.ps1 70'
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'cabinet-repro-driver' -Action $action -Principal $principal -Settings $settings -Force
Get-ScheduledTask -TaskName 'cabinet-repro-driver' | Select-Object TaskName, State | Format-List

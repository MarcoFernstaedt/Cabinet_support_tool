<#  Installs a user-context Tailscale restore task on the cabinet.

  The SYSTEM watchdog covers the service but not the node: `tailscale up` running as SYSTEM
  fails with "the target profile does not belong to the user", so the node stays down. Only a
  process in the signed-in user's context can bring the node up - the same reason the tray
  Connect button works and a service restart on its own does not.

  This installs a second task on the same watchdog script, in that user's context, every
  thirty minutes and at logon. Takes effect the next time the node is up; it cannot be
  installed while the machine is off the tailnet.
#>
$user = "$env:COMPUTERNAME\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\tailscale-watchdog.ps1'
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 30)
$logon = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'tailscale-watchdog-user' -Action $action -Trigger $repeat, $logon -Principal $principal -Settings $settings -Force
Get-ScheduledTask -TaskName 'tailscale-watchdog-user' | Select-Object TaskName, State | Format-List

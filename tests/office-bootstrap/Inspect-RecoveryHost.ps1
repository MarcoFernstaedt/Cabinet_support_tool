$ErrorActionPreference='Stop'
$script:recoveryProcessSource=Join-Path $PSScriptRoot 'RecoveryProcess.cs'
$t=$null;$e=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Restore-CabinetDemoAgent.ps1'),[ref]$t,[ref]$e)
foreach($d in $ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst]}){. ([scriptblock]::Create($d.Extent.Text))}
$serviceName='CabinetPlatformAgent';$install='C:\Program Files\Mashura\CabinetAgent'
$s=Get-CimInstance Win32_Service -Filter "Name='CabinetPlatformAgent'"
$s | Select-Object Name,State,StartMode,PathName,ProcessId
Service-Recovery | Select-Object Type,Start,Error,Display,Reset,Count,ActionSequence,FailureFlag,Delayed,Sid,TriggerCount,Group,Dependencies,Privileges,Reboot,Command,Dacl
$launch=Read-ProcessLaunch $s.ProcessId
Assert-LaunchEnvironment $launch (Join-Path $install 'CabinetPlatform.Agent.exe')
Write-Output 'LIVE_AGENT_PROCESS_ENVIRONMENT_PASS'
Assert-ExecutionEnvironment
Write-Output 'LIVE_READ_ONLY_ENVIRONMENT_PASS'
Service-Admission
Write-Output 'LIVE_READ_ONLY_SERVICE_ADMISSION_PASS'

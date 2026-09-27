# Fresh Windows PowerShell 5.1 child: imports actual helper and native adapters.
param([string]$Manual,[string]$ProbeService,[string]$ProbeInstall,[string]$Backup,[string]$Zip,[string]$Digest,[string]$Commit,[string]$Phase,[string]$Scenario)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if($Phase -notin @('prepare','restore')){throw 'Unknown phase'}
# Script entrypoints are run with the exact operator arguments in this child.
if($Phase -eq 'prepare'){

 & $Manual -Prepare -ConfirmSameMachine -BackupRoot $Backup
 $runs=@(Get-ChildItem -LiteralPath $Backup -Directory -Filter 'manual-reinstall-*')
 if($runs.Count -ne 1 -or (Get-Service $ProbeService -ErrorAction SilentlyContinue) -or (Test-Path $ProbeInstall) -or
    !(Test-Path (Join-Path $runs[0].FullName 'original-copy\office-enrollment.json.device')) -or
    !(Test-Path (Join-Path $runs[0].FullName 'original-installed\state\agent-state.json'))){throw 'Prepare result mismatch'}
 Write-Output 'PASS prepare removed exact service and archived original private state'
 exit 0
}
$runs=@(Get-ChildItem -LiteralPath $Backup -Directory -Filter 'manual-reinstall-*')
if($runs.Count -ne 1){throw 'Backup handle missing'}
if($Scenario -eq 'alias'){
 New-Item -ItemType Junction -Path $ProbeInstall -Target $runs[0].FullName | Out-Null
 try {
  $failure=''
  try { & $Manual -Restore -ConfirmSameMachine -BackupHandle $runs[0].FullName -AgentZip $Zip -ExpectedSha256 $Digest -ExpectedSourceCommit $Commit }
  catch { $failure=$_.Exception.Message }
  if(!$failure -or (Get-Service $ProbeService -ErrorAction SilentlyContinue)){throw 'Alias destination was admitted'}
  if(!(Test-Path (Join-Path $runs[0].FullName 'original-copy\office-enrollment.json.device'))){throw 'Backup changed after alias refusal'}
  Write-Output 'PASS destination junction refused before identity copy'
 } finally { & "$env:SystemRoot\System32\cmd.exe" /c rmdir $ProbeInstall | Out-Null; if($LASTEXITCODE){throw 'Exact junction cleanup failed'} }
 exit 0
}
if($Scenario -eq 'tamper'){
 [IO.File]::AppendAllText((Join-Path $runs[0].FullName 'original-copy\state\agent-state.json'),' ')
}
if($Scenario -eq 'prestart' -or $Scenario -eq 'poststart'){
 # Separate clean process, production entrypoint, injection via a disposable copy
 # of the helper before it is invoked. No adapter replacement or real Agent.
 $text=[IO.File]::ReadAllText($Manual)
 if($Scenario -eq 'prestart'){
  $before='[CabinetRecoveryDefinition]::CreateFromSnapshot($serviceName,$value)'
  $text=$text.Replace($before,($before+"`r`n            throw 'synthetic prestart failure'"))
 }else{
  $before="            Service-SetStart 'auto'; Assert-Service 'Auto' 'Running'; Same-Definition `$value"
  $text=$text.Replace($before,("            [IO.File]::WriteAllText((Join-Path `$install 'state\advanced-journal.txt'),'advanced after start')`n            throw 'synthetic poststart failure'`n"+$before))
 }
 $injected=Join-Path (Split-Path $Manual) 'Injected-Manual.ps1'
 if($text -eq [IO.File]::ReadAllText($Manual)){throw 'Failure injection did not bind'}
 [IO.File]::WriteAllText($injected,$text)
 $Manual=$injected
}
$failure=''
try { & $Manual -Restore -ConfirmSameMachine -BackupHandle $runs[0].FullName -AgentZip $Zip -ExpectedSha256 $Digest -ExpectedSourceCommit $Commit }
catch { $failure=$_.Exception.Message; Write-Output "EXPECTED_FAILURE=$failure STACK=$($_.ScriptStackTrace)" }
$svc=Get-CimInstance Win32_Service -Filter ("Name='"+$ProbeService+"'")
if($Scenario -eq 'tamper'){
 if($failure -notlike '*Backup bytes changed*' -or $svc -or (Test-Path $ProbeInstall)){throw 'Tampered backup was not refused before effects'}
 Write-Output 'PASS protected backup tamper refused before service or install effects'
 exit 0
}
if(!$svc){throw 'Restored service missing'}
if($svc.PathName -cne ('"'+$ProbeInstall+'\CabinetPlatform.Agent.exe"') -or $svc.StartName -cne 'LocalSystem') {throw 'SCM image or identity changed'}
if((Get-Content -LiteralPath (Join-Path $ProbeInstall 'state\agent-state.json') -Raw | ConvertFrom-Json).MachineId -cne 'synthetic-manual'){throw 'Original identity lost'}
if($Scenario -notin @('prestart','poststart')){
 if($failure -or $svc.State -cne 'Running' -or $svc.StartMode -cne 'Auto'){throw "Success mismatch: $failure"}
 Write-Output 'PASS clean restore Running Auto and original synthetic identity'
}elseif($Scenario -eq 'prestart'){
 if($failure -notlike '*Prestart install incomplete: synthetic prestart failure*' -or $svc.State -cne 'Stopped' -or $svc.StartMode -cne 'Disabled'){throw 'Prestart state mismatch'}
 Write-Output 'PASS prestart partial registration remains Stopped Disabled'
}else{
 if($failure -notlike '*Poststart fail-stopped: synthetic poststart failure*' -or $svc.State -cne 'Stopped' -or $svc.StartMode -cne 'Disabled' -or !(Test-Path (Join-Path $ProbeInstall 'state\advanced-journal.txt'))){throw 'Poststart journal/state mismatch'}
 Write-Output 'PASS poststart Stopped Disabled and advanced journal retained'
}

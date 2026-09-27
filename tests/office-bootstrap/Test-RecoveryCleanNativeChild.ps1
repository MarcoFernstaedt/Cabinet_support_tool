# Fresh PowerShell process: no Add-Type or service adapter stubs before import.
param([string]$Helper,[string]$ProbeService,[string]$ProbeInstall,[string]$Backup,[string]$Scenario)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if($PSVersionTable.PSVersion.ToString() -notlike '5.1.*'){throw 'Windows PowerShell 5.1 required'}
try { . $Helper } catch { if($_.Exception.Message -notlike '*Explicit same-machine confirmation*'){throw} }
# Only fixture bindings change. Imported production functions, sidecar path and
# native SCM/file adapters remain intact; the live Agent is never targeted.
$serviceName=$ProbeService; $install=$ProbeInstall
$baseline=Service-Recovery
$package=@{'cabinetplatform.agent.exe'=[pscustomobject]@{Name='CabinetPlatform.Agent.exe';Bytes=[IO.File]::ReadAllBytes((Join-Path $install 'CabinetPlatform.Agent.exe'))}}
if($Scenario -eq 'prestart'){
 $script:originalSetStart=${function:Service-SetStart}
 function Service-SetStart([string]$mode){ & $script:originalSetStart $mode; if($mode -eq 'disabled'){throw 'synthetic prestart effect failure'} }
}
if($Scenario -eq 'poststart'){
 $script:originalStart=${function:Service-Start}
 function Service-Start {
  & $script:originalStart
  [IO.File]::AppendAllText((Join-Path $install 'state\agent-state.json'),"`r`n")
  [IO.File]::WriteAllText((Join-Path $install 'state\new-journal-marker.txt'),'advanced after start')
  throw 'synthetic poststart journal failure'
 }
}
$failure=''
try { Invoke-Recovery $package $Backup } catch { $failure=$_.Exception.Message; Write-Output "EXPECTED_FAILURE=$failure" }
$svc=Service-Read; $after=Service-Recovery
if($after.Image -cne $baseline.Image -or $after.Account -cne $baseline.Account -or $after.Display -cne $baseline.Display -or $after.Dacl -cne $baseline.Dacl -or $after.Policy -cne $baseline.Policy){throw 'Retained SCM registration changed'}
Write-Output 'PASS retained native SCM metadata'
$runs=@(Get-ChildItem -LiteralPath $Backup -Directory -Filter 'agent-recovery-*')
if($runs.Count -ne 1){throw 'One recovery root expected'}
if($Scenario -eq 'success'){
 if($failure -or $svc.State -cne 'Running' -or $svc.StartMode -cne 'Auto'){throw "Success state mismatch: $failure"}
 if(!(Test-Path (Join-Path $runs[0].FullName 'original-copy\CabinetPlatform.Agent.exe'))){throw 'Stopped-state backup absent'}
 if((Get-Content (Join-Path $install 'state\agent-state.json') -Raw | ConvertFrom-Json).MachineId -cne 'synthetic-clean'){throw 'Identity lost'}
 Write-Output 'PASS full transaction backup and preserved identity; Running Auto'
}elseif($Scenario -eq 'prestart'){
 if($failure -notlike '*Recovery failed before start: synthetic prestart effect failure*' -or $svc.State -cne 'Running' -or $svc.StartMode -cne 'Auto'){throw 'Prestart rollback mismatch'}
 if(Test-Path (Join-Path $runs[0].FullName 'original-copy\CabinetPlatform.Agent.exe')){throw 'Early failure falsely treated as backup'}
 Write-Output 'PASS prestart effect failure restored Running Auto; no stopped backup'
}elseif($Scenario -eq 'poststart'){
 if($failure -notlike '*Poststart failure: synthetic poststart journal failure*' -or $svc.State -cne 'Stopped' -or $svc.StartMode -cne 'Disabled'){throw 'Poststart fail-stop mismatch'}
 if(!(Test-Path (Join-Path $install 'state\new-journal-marker.txt'))){throw 'Advanced journal marker lost'}
 if(!(Test-Path (Join-Path $runs[0].FullName 'original-copy\CabinetPlatform.Agent.exe'))){throw 'Stopped backup absent'}
 Write-Output 'PASS poststart stopped disabled; advanced journal retained'
}else{throw 'Invalid scenario'}

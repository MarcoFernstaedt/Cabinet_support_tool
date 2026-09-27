$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
try{. (Join-Path $PSScriptRoot 'Restore-CabinetDemoAgent.ps1')}catch{if($_.Exception.Message -notlike '*Explicit same-machine confirmation*'){throw}}
Assert-Service 'Auto' 'Running'
Service-Admission
Assert-ExecutionEnvironment
Check-Ancestors $install
Check-Tree $install
$d=Service-Recovery
if($d.OwnerGroup -eq $null){throw 'Owner/group metadata unavailable'}
Write-Output 'HP_READONLY_SERVICE_ADMISSION_PASS'
Write-Output 'HP_READONLY_ENVIRONMENT_WITNESS_PASS'
Write-Output "HP_READONLY_STATUS=$((Service-Read).State)"

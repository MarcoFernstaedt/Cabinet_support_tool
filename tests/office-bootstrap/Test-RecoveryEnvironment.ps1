$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Restore-CabinetDemoAgent.ps1'),[ref]$t,[ref]$e)
foreach($d in $ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst]}){. ([scriptblock]::Create($d.Extent.Text))}
$script:recoveryProcessSource=Join-Path $PSScriptRoot 'RecoveryProcess.cs'
$n=0
foreach($key in @('Serilog__WriteTo__0__Name','Agent:StateDirectory','DOTNET_STARTUP_HOOKS','CORECLR_ENABLE_PROFILING')){
 $refused=$false;try{Assert-EnvironmentEntries @([pscustomobject]@{Key=$key})}catch{$refused=$true}
 if(!$refused){throw "FAIL environment injection accepted: $key"};$n++
}
$env:CabinetRecoverySyntheticWitness='synthetic-only'
try{
 $p=Read-ProcessLaunch $PID
 if($p.Environment['CabinetRecoverySyntheticWitness'] -cne 'synthetic-only'){throw 'Actual process environment not read'};$n++
 $fake=[pscustomobject]@{UserSid='S-1-5-18';Image='C:\synthetic.exe';CommandLine='"C:\synthetic.exe"';Environment=@{Agent__StateDirectory='synthetic'}}
 $refused=$false;try{Assert-LaunchEnvironment $fake 'C:\synthetic.exe'}catch{$refused=$true}
 if(!$refused){throw 'Effective process override accepted'};$n++
 $fake.Environment=@{};$fake.CommandLine+=' --wrong';$refused=$false
 try{Assert-LaunchEnvironment $fake 'C:\synthetic.exe'}catch{$refused=$true}
 if(!$refused){throw 'Process arguments accepted'};$n++
 Write-Output "ENVIRONMENT_CHECKS=$n"
}finally{Remove-Item Env:CabinetRecoverySyntheticWitness}
